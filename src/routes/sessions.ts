import { Elysia, t } from 'elysia';
import { Db, ObjectId, OptionalId } from 'mongodb';

import type { Env } from '../config.js';
import type { StudySession, User } from '../types.js';
import { isWithinRadius } from '../utils/geo.js';
import { isLoginSessionActive, normalizeDeviceId } from '../utils/login-sessions.js';

type JwtService = {
  verify: (token?: string) => Promise<{
    sub?: string;
    email?: string;
    provider?: string;
    isDeveloper?: boolean;
  } | false>;
};

type AppSingleton = {
  decorator: {
    db: Db;
    env: Env;
    jwt: JwtService;
  };
  store: {};
  derive: {};
  resolve: {
    authUserId: string;
    authUserEmail?: string;
    authUserProvider?: string;
    isDeveloperAccount: boolean;
    authDeviceId: string;
  };
};

function clampPomodoroMinutes(value: unknown, fallback: number) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) {
    return fallback;
  }
  return Math.max(1, Math.min(180, Math.floor(minutes)));
}

function getPomodoroFocusSeconds(totalSeconds: number, focusMinutes = 25, breakMinutes = 5) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const focusSeconds = clampPomodoroMinutes(focusMinutes, 25) * 60;
  const breakSeconds = clampPomodoroMinutes(breakMinutes, 5) * 60;
  const cycleSeconds = focusSeconds + breakSeconds;
  const completeCycles = Math.floor(safeSeconds / cycleSeconds);
  const cyclePosition = safeSeconds % cycleSeconds;
  return completeCycles * focusSeconds + Math.min(cyclePosition, focusSeconds);
}

function getStudyDurationSeconds(session: StudySession, accumulatedSeconds: number) {
  if (session.timerMode !== 'pomodoro') {
    return Math.max(0, Math.floor(accumulatedSeconds));
  }

  return getPomodoroFocusSeconds(
    accumulatedSeconds,
    session.pomodoroFocusMinutes,
    session.pomodoroBreakMinutes
  );
}

function isInsideSchoolBoundary(env: Env, latitude: number, longitude: number) {
  return isWithinRadius(latitude, longitude, env.SCHOOL_LAT, env.SCHOOL_LNG, env.SCHOOL_RADIUS_M);
}

function isHttpRequest(headers: Record<string, string | undefined>, request?: Request) {
  const proto = headers['x-forwarded-proto'] ?? '';
  const origin = headers.origin ?? '';
  const referer = headers.referer ?? '';
  const requestProtocol = request ? new URL(request.url).protocol : '';
  return proto === 'http' || requestProtocol === 'http:' || origin.startsWith('http://') || referer.startsWith('http://');
}

async function canSkipLocationBoundary(
  db: Db,
  userId: ObjectId,
  headers: Record<string, string | undefined>,
  request: Request | undefined,
  isDeveloperAccount: boolean
) {
  if (isHttpRequest(headers, request) || isDeveloperAccount) {
    return true;
  }

  const user = await db.collection<OptionalId<User>>('users').findOne(
    { _id: userId },
    { projection: { provider: 1, email: 1 } }
  );
  return user?.provider === 'dev' || user?.email === 'dev@timer.local';
}

async function checkSchoolBoundary(
  db: Db,
  env: Env,
  userId: ObjectId,
  headers: Record<string, string | undefined>,
  request: Request | undefined,
  isDeveloperAccount: boolean,
  latitude: number,
  longitude: number
) {
  if (await canSkipLocationBoundary(db, userId, headers, request, isDeveloperAccount)) {
    return true;
  }
  return isInsideSchoolBoundary(env, latitude, longitude);
}

async function findActiveSession(
  db: Db,
  env: Env,
  userId: ObjectId,
  sessionIdValue?: string,
  status: StudySession['status'] | { $in: StudySession['status'][] } = { $in: ['running', 'paused'] }
) {
  const sessions = db.collection<OptionalId<StudySession>>('study_sessions');
  let sessionId: ObjectId | null = null;
  if (sessionIdValue) {
    try {
      sessionId = new ObjectId(sessionIdValue);
    } catch {
      sessionId = null;
    }
  }

  let session = sessionId ? await sessions.findOne({ _id: sessionId, userId }) : null;
  if (!session && sessionId && !env.isProd) {
    session = await sessions.findOne({ _id: sessionId });
  }
  if (!session) {
    session = await sessions.findOne({ userId, status }, { sort: { updatedAt: -1 } });
  }
  return session;
}

async function stopStudySession(
  db: Db,
  session: StudySession,
  latitude: number,
  longitude: number,
  stoppedAt: Date,
  stopReason?: string
) {
  const sessions = db.collection<OptionalId<StudySession>>('study_sessions');
  let accumulatedSeconds = session.accumulatedSeconds ?? 0;

  if (session.status === 'running') {
    const deltaSeconds = Math.max(
      0,
      Math.floor((stoppedAt.getTime() - session.lastStartedAt.getTime()) / 1000)
    );
    accumulatedSeconds += deltaSeconds;
  }

  const durationSeconds = getStudyDurationSeconds(session, accumulatedSeconds);

  await sessions.updateOne(
    { _id: session._id },
    {
      $set: {
        status: 'stopped',
        stoppedAt,
        durationSeconds,
        accumulatedSeconds,
        lastLatitude: latitude,
        lastLongitude: longitude,
        lastRecordedAt: stoppedAt,
        updatedAt: stoppedAt,
        ...(stopReason ? { stopReason } : {}),
      },
    }
  );

  return { sessionId: session._id.toString(), status: 'stopped' as const, durationSeconds };
}

function requireAuth() {
  return new Elysia<'', AppSingleton>().resolve({ as: 'global' }, async ({ jwt, headers, query, db, status }) => {
    const authHeader = headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return status(401, { error: 'Missing auth token.' });
    }

    const token = authHeader.slice('Bearer '.length);
    const payload = await jwt.verify(token);

    if (payload === false || !payload.sub) {
      return status(401, { error: 'Invalid auth token.' });
    }

    const isDeveloperAccount =
      payload.isDeveloper === true || payload.provider === 'dev' || payload.email === 'dev@timer.local';
    const authDeviceId = normalizeDeviceId(String(query.deviceId ?? query.device_id ?? headers['x-device-id'] ?? ''));
    const isActive = await isLoginSessionActive(db, new ObjectId(payload.sub), authDeviceId);

    if (!isActive) {
      return status(401, { error: 'Session has been revoked.', code: 'SESSION_REVOKED' });
    }

    return {
      authUserId: payload.sub,
      authUserEmail: payload.email,
      authUserProvider: payload.provider,
      isDeveloperAccount,
      authDeviceId,
    };
  });
}

export const sessionRoutes = new Elysia<'/sessions', AppSingleton>({ prefix: '/sessions' })
  .use(requireAuth())
  .post(
    '/start',
    async ({ body, headers, request, env, db, authUserId, isDeveloperAccount, set }) => {
      const userId = new ObjectId(authUserId);
      const inside = await checkSchoolBoundary(
        db,
        env,
        userId,
        headers,
        request,
        isDeveloperAccount,
        body.latitude,
        body.longitude
      );

      if (!inside) {
        set.status = 403;
        return { error: 'Outside school boundary.' };
      }

      const sessions = db.collection<OptionalId<StudySession>>('study_sessions');
      const now = new Date(body.startedAt ?? Date.now());

      const existing = await sessions.findOne({ userId, status: 'running' });
      if (existing) {
        return {
          sessionId: existing._id.toString(),
          status: 'running',
          accumulatedSeconds: existing.accumulatedSeconds ?? 0,
          lastStartedAt: existing.lastStartedAt?.toISOString(),
          timerMode: existing.timerMode ?? 'basic',
          pomodoroFocusMinutes: existing.pomodoroFocusMinutes,
          pomodoroBreakMinutes: existing.pomodoroBreakMinutes,
        };
      }

      const timerMode = body.timerMode === 'pomodoro' ? 'pomodoro' : 'basic';

      const result = await sessions.insertOne({
        userId,
        subjectId: body.subjectId,
        timerMode,
        pomodoroFocusMinutes: timerMode === 'pomodoro' ? clampPomodoroMinutes(body.pomodoroFocusMinutes, 25) : undefined,
        pomodoroBreakMinutes: timerMode === 'pomodoro' ? clampPomodoroMinutes(body.pomodoroBreakMinutes, 5) : undefined,
        status: 'running',
        startedAt: now,
        lastStartedAt: now,
        accumulatedSeconds: 0,
        lastLatitude: body.latitude,
        lastLongitude: body.longitude,
        lastRecordedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      return {
        sessionId: result.insertedId.toString(),
        status: 'running',
        accumulatedSeconds: 0,
        lastStartedAt: now.toISOString(),
        timerMode,
        pomodoroFocusMinutes: timerMode === 'pomodoro' ? clampPomodoroMinutes(body.pomodoroFocusMinutes, 25) : undefined,
        pomodoroBreakMinutes: timerMode === 'pomodoro' ? clampPomodoroMinutes(body.pomodoroBreakMinutes, 5) : undefined,
      };
    },
    {
      body: t.Object({
        subjectId: t.Optional(t.String()),
        timerMode: t.Optional(t.Union([t.Literal('basic'), t.Literal('pomodoro')])),
        pomodoroFocusMinutes: t.Optional(t.Number()),
        pomodoroBreakMinutes: t.Optional(t.Number()),
        latitude: t.Number(),
        longitude: t.Number(),
        startedAt: t.Optional(t.String()),
      }),
      detail: { summary: 'Start session' },
    }
  )
  .post(
    '/pause',
    async ({ body, env, db, authUserId, set }) => {
      const sessions = db.collection<OptionalId<StudySession>>('study_sessions');
      const userId = new ObjectId(authUserId);
      const session = await findActiveSession(db, env, userId, body.sessionId, 'running');

      if (!session) {
        set.status = 404;
        return { error: 'Session not found.' };
      }

      if (session.status !== 'running') {
        set.status = 409;
        return { error: 'Session is not running.' };
      }

      const pausedAt = new Date(body.pausedAt ?? Date.now());
      const deltaSeconds = Math.max(
        0,
        Math.floor((pausedAt.getTime() - session.lastStartedAt.getTime()) / 1000)
      );
      const accumulatedSeconds = (session.accumulatedSeconds ?? 0) + deltaSeconds;

      await sessions.updateOne(
        { _id: session._id },
        {
          $set: {
            status: 'paused',
            accumulatedSeconds,
            lastLatitude: body.latitude,
            lastLongitude: body.longitude,
            lastRecordedAt: pausedAt,
            updatedAt: pausedAt,
          },
        }
      );

      return { sessionId: session._id.toString(), status: 'paused', accumulatedSeconds };
    },
    {
      body: t.Object({
        sessionId: t.Optional(t.String({ minLength: 12 })),
        latitude: t.Number(),
        longitude: t.Number(),
        pausedAt: t.Optional(t.String()),
      }),
      detail: { summary: 'Pause session' },
    }
  )
  .post(
    '/resume',
    async ({ body, headers, request, env, db, authUserId, isDeveloperAccount, set }) => {
      const userId = new ObjectId(authUserId);
      const inside = await checkSchoolBoundary(
        db,
        env,
        userId,
        headers,
        request,
        isDeveloperAccount,
        body.latitude,
        body.longitude
      );

      if (!inside) {
        set.status = 403;
        return { error: 'Outside school boundary.' };
      }

      const sessions = db.collection<OptionalId<StudySession>>('study_sessions');
      const session = await findActiveSession(db, env, userId, body.sessionId, 'paused');

      if (!session) {
        set.status = 404;
        return { error: 'Session not found.' };
      }

      if (session.status !== 'paused') {
        set.status = 409;
        return { error: 'Session is not paused.' };
      }

      const resumedAt = new Date(body.resumedAt ?? Date.now());

      await sessions.updateOne(
        { _id: session._id },
        {
          $set: {
            status: 'running',
            lastStartedAt: resumedAt,
            lastLatitude: body.latitude,
            lastLongitude: body.longitude,
            lastRecordedAt: resumedAt,
            updatedAt: resumedAt,
          },
        }
      );

      return { sessionId: session._id.toString(), status: 'running' };
    },
    {
      body: t.Object({
        sessionId: t.Optional(t.String({ minLength: 12 })),
        latitude: t.Number(),
        longitude: t.Number(),
        resumedAt: t.Optional(t.String()),
      }),
      detail: { summary: 'Resume session' },
    }
  )
  .post(
    '/stop',
    async ({ body, env, db, authUserId, set }) => {
      const userId = new ObjectId(authUserId);
      const session = await findActiveSession(db, env, userId, body.sessionId);

      if (!session) {
        set.status = 404;
        return { error: 'Session not found.' };
      }

      const stoppedAt = new Date(body.stoppedAt ?? Date.now());
      return stopStudySession(db, session, body.latitude, body.longitude, stoppedAt);
    },
    {
      body: t.Object({
        sessionId: t.Optional(t.String({ minLength: 12 })),
        latitude: t.Number(),
        longitude: t.Number(),
        stoppedAt: t.Optional(t.String()),
      }),
      detail: { summary: 'Stop session' },
    }
  );

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function getKstDayRange(date = new Date()) {
  const kstMs = date.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  kstDate.setUTCHours(0, 0, 0, 0);
  const start = new Date(kstDate.getTime() - KST_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function getKstWeekRange(date = new Date()) {
  const kstMs = date.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  kstDate.setUTCHours(0, 0, 0, 0);
  const kstDay = kstDate.getUTCDay();
  const diff = (kstDay === 0 ? -6 : 1) - kstDay;
  const weekStartKst = new Date(kstDate.getTime() + diff * 24 * 60 * 60 * 1000);
  const start = new Date(weekStartKst.getTime() - KST_OFFSET_MS);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

sessionRoutes
  .post(
    '/location-check',
    async ({ body, headers, request, env, db, authUserId, isDeveloperAccount }) => {
      const userId = new ObjectId(authUserId);
      return {
        inside: await checkSchoolBoundary(
          db,
          env,
          userId,
          headers,
          request,
          isDeveloperAccount,
          body.latitude,
          body.longitude
        ),
        radiusMeters: env.SCHOOL_RADIUS_M,
      };
    },
    {
      body: t.Object({
        latitude: t.Number(),
        longitude: t.Number(),
      }),
      detail: { summary: 'Check school boundary' },
    }
  )
  .post(
    '/heartbeat',
    async ({ body, headers, request, env, db, authUserId, isDeveloperAccount, set }) => {
      const userId = new ObjectId(authUserId);
      const session = await findActiveSession(db, env, userId, body.sessionId, 'running');

      if (!session) {
        set.status = 404;
        return { error: 'Session not found.' };
      }

      const recordedAt = new Date(body.recordedAt ?? Date.now());
      const inside = await checkSchoolBoundary(
        db,
        env,
        userId,
        headers,
        request,
        isDeveloperAccount,
        body.latitude,
        body.longitude
      );

      if (!inside) {
        const stopped = await stopStudySession(
          db,
          session,
          body.latitude,
          body.longitude,
          recordedAt,
          'outside_school_boundary'
        );
        return { ...stopped, inside, stoppedDueToBoundary: true };
      }

      await db.collection<OptionalId<StudySession>>('study_sessions').updateOne(
        { _id: session._id },
        {
          $set: {
            lastLatitude: body.latitude,
            lastLongitude: body.longitude,
            lastRecordedAt: recordedAt,
            updatedAt: recordedAt,
          },
        }
      );

      return {
        sessionId: session._id.toString(),
        status: 'running',
        inside,
        stoppedDueToBoundary: false,
      };
    },
    {
      body: t.Object({
        sessionId: t.Optional(t.String({ minLength: 12 })),
        latitude: t.Number(),
        longitude: t.Number(),
        recordedAt: t.Optional(t.String()),
      }),
      detail: { summary: 'Update active session location' },
    }
  )
  .get('/active', async ({ db, authUserId }) => {
    const sessions = db.collection<OptionalId<StudySession>>('study_sessions');
    const userId = new ObjectId(authUserId);
    const active = await sessions.findOne(
      { userId, status: { $in: ['running', 'paused'] } },
      { sort: { updatedAt: -1 } }
    );

    if (!active) {
      return { session: null };
    }

    return {
      session: {
        sessionId: active._id.toString(),
        subjectId: active.subjectId,
        status: active.status,
        accumulatedSeconds: active.accumulatedSeconds ?? 0,
        lastStartedAt: active.lastStartedAt?.toISOString(),
        startedAt: active.startedAt?.toISOString(),
        timerMode: active.timerMode ?? 'basic',
        pomodoroFocusMinutes: active.pomodoroFocusMinutes,
        pomodoroBreakMinutes: active.pomodoroBreakMinutes,
      },
    };
  })
  .get('/summary/daily', async ({ db, authUserId }) => {
    return buildSummary(db, authUserId, getKstDayRange());
  })
  .get('/summary/weekly', async ({ db, authUserId }) => {
    return buildSummary(db, authUserId, getKstWeekRange());
  });

async function buildSummary(
  db: Db,
  authUserId: string,
  range: { start: Date; end: Date }
) {
  const sessions = db.collection<OptionalId<StudySession>>('study_sessions');
  const userId = new ObjectId(authUserId);
  const totals = await sessions
    .aggregate([
      {
        $addFields: {
          stoppedAtResolved: {
            $convert: {
              input: '$stoppedAt',
              to: 'date',
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $match: {
          userId,
          status: 'stopped',
          stoppedAtResolved: { $gte: range.start, $lt: range.end },
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: '$userId',
          totalSeconds: { $sum: '$durationSeconds' },
          sessions: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const totalSeconds = totals[0]?.totalSeconds ?? 0;
  const sessionCount = totals[0]?.sessions ?? 0;

  return {
    range,
    totalSeconds,
    sessionCount,
  };
}
