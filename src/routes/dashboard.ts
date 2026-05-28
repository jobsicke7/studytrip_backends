import { Elysia, t } from 'elysia';
import { Db, ObjectId, OptionalId } from 'mongodb';

import type { Env } from '../config.js';
import type { Goal, LoginSession, StudySession, Subject, TimerPreferences, User } from '../types.js';
import {
  buildLoginSessionMetadata,
  isLoginSessionActive,
  normalizeDeviceId,
  toLoginSessionResponse,
  touchLoginSession,
} from '../utils/login-sessions.js';
import { notifySessionRevoked, registerSessionSocket, unregisterSessionSocket } from '../utils/session-events.js';

type JwtService = {
  verify: (token?: string) => Promise<{ sub?: string } | false>;
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
    authDeviceId: string;
  };
};

const defaultSubjects = [
  { subjectId: 'korean', label: '국어', order: 0, color: '#6EE7B7', icon: 'menu-book' },
  { subjectId: 'math', label: '수학', order: 1, color: '#93C5FD', icon: 'calculate' },
  { subjectId: 'english', label: '영어', order: 2, color: '#F59E0B', icon: 'text-fields' },
  { subjectId: 'science', label: '과학', order: 3, color: '#A78BFA', icon: 'science' },
  { subjectId: 'society', label: '사회', order: 4, color: '#EC4899', icon: 'account-balance' },
];

const STREAK_MIN_DAILY_SECONDS = 5 * 60;

const defaultGoals = [
  {
    goalId: 'monthly-100h',
    title: '이번 달 100시간 학습',
    targetSeconds: 100 * 60 * 60,
    period: 'monthly' as const,
    order: 0,
  },
  {
    goalId: 'weekly-10h',
    title: '이번주 10시간 학습',
    targetSeconds: 10 * 60 * 60,
    period: 'weekly' as const,
    order: 1,
  },
];

const defaultTimerPreferences = {
  pomodoroFocusMinutes: 25,
  pomodoroBreakMinutes: 5,
  pomodoroLongBreakMinutes: 20,
  pomodoroLongBreakInterval: 4,
  pomodoroAlarmOn: true,
  pomodoroFocusWhiteNoise: 'none',
  pomodoroBreakWhiteNoise: 'none',
  pomodoroFocusWhiteNoiseVolume: 0.42,
  pomodoroBreakWhiteNoiseVolume: 0.42,
  whiteNoiseVolume: 0.42,
};

const dayLabels = ['월', '화', '수', '목', '금', '토', '일'];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function requireAuth() {
  return new Elysia<'', AppSingleton>().resolve({ as: 'global' }, async ({ jwt, headers, query, db, status }) => {
    const authHeader = headers.authorization ?? '';
    const queryToken = typeof query.token === 'string' ? query.token : '';
    if (!authHeader.startsWith('Bearer ') && !queryToken) {
      return status(401, { error: 'Missing auth token.' });
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : queryToken;
    const payload = await jwt.verify(token);

    if (payload === false || !payload.sub) {
      return status(401, { error: 'Invalid auth token.' });
    }

    const authDeviceId = normalizeDeviceId(String(query.deviceId ?? query.device_id ?? headers['x-device-id'] ?? ''));
    const isActive = await isLoginSessionActive(db, new ObjectId(payload.sub), authDeviceId);

    if (!isActive) {
      return status(401, { error: 'Session has been revoked.', code: 'SESSION_REVOKED' });
    }

    return { authUserId: payload.sub, authDeviceId };
  });
}

export const dashboardRoutes = new Elysia<'', AppSingleton>()
  .use(requireAuth())
  .ws('/account/session-events', {
    open(ws) {
      const data = ws.data as unknown as { authUserId: string; authDeviceId: string };
      registerSessionSocket(data.authUserId, data.authDeviceId, ws);
    },
    close(ws) {
      const data = ws.data as unknown as { authUserId: string; authDeviceId: string };
      unregisterSessionSocket(data.authUserId, data.authDeviceId, ws);
    },
    message(ws, message) {
      if (message === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    },
  })
  .get('/me', async ({ db, authUserId, set }) => {
    const user = await db.collection<OptionalId<User>>('users').findOne({ _id: new ObjectId(authUserId) });
    if (!user) {
      set.status = 404;
      return { error: 'User not found.' };
    }

    return {
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
    };
  })
  .patch(
    '/me',
    async ({ db, authUserId, body, set }) => {
      const user = await db.collection<OptionalId<User>>('users').findOneAndUpdate(
        { _id: new ObjectId(authUserId) },
        { $set: { name: body.name.trim(), updatedAt: new Date() } },
        { returnDocument: 'after' }
      );

      if (!user) {
        set.status = 404;
        return { error: 'User not found.' };
      }

      return {
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
      };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 30 }),
      }),
    }
  )
  .get('/account/sessions', async ({ db, authUserId, headers, query, request, server }) => {
    const userId = new ObjectId(authUserId);
    const currentDeviceId = normalizeDeviceId(String(query.deviceId ?? query.device_id ?? headers['x-device-id'] ?? ''));
    const metadata = buildLoginSessionMetadata({ query, headers, request, server });

    if (currentDeviceId !== 'default') {
      await touchLoginSession(db, userId, { ...metadata, deviceId: currentDeviceId });
    }

    const sessions = await db
      .collection<OptionalId<LoginSession>>('login_sessions')
      .find({ userId, isActive: { $ne: false } })
      .sort({ lastSeenAt: -1, lastLogin: -1 })
      .toArray();

    return {
      items: sessions.map((session) => toLoginSessionResponse(session as LoginSession, currentDeviceId)),
    };
  })
  .patch(
    '/account/sessions/current/location',
    async ({ db, authUserId, authDeviceId, body, set }) => {
      if (!authDeviceId || authDeviceId === 'default') {
        set.status = 400;
        return { error: 'Current device id is required.' };
      }

      const now = new Date();
      const update: Partial<LoginSession> & { updatedAt: Date } = {
        updatedAt: now,
      };

      if (body.regionName !== undefined) update.regionName = body.regionName ?? null;
      if (body.cityName !== undefined) update.cityName = body.cityName ?? null;
      if (body.districtName !== undefined) update.districtName = body.districtName ?? null;
      if (body.countryName !== undefined) update.countryName = body.countryName ?? null;
      if (body.latitude !== undefined) update.latitude = body.latitude ?? null;
      if (body.longitude !== undefined) update.longitude = body.longitude ?? null;

      await db
        .collection<OptionalId<LoginSession>>('login_sessions')
        .updateOne({ userId: new ObjectId(authUserId), deviceId: authDeviceId }, { $set: update });

      return { ok: true };
    },
    {
      body: t.Object({
        regionName: t.Optional(t.Union([t.String(), t.Null()])),
        cityName: t.Optional(t.Union([t.String(), t.Null()])),
        districtName: t.Optional(t.Union([t.String(), t.Null()])),
        countryName: t.Optional(t.Union([t.String(), t.Null()])),
        latitude: t.Optional(t.Union([t.Number(), t.Null()])),
        longitude: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
    }
  )
  .patch(
    '/account/sessions/current/metadata',
    async ({ db, authUserId, authDeviceId, body, set }) => {
      if (!authDeviceId || authDeviceId === 'default') {
        set.status = 400;
        return { error: 'Current device id is required.' };
      }

      const now = new Date();
      const update: Partial<LoginSession> & { updatedAt: Date } = {
        updatedAt: now,
      };

      if (body.deviceName !== undefined) update.deviceName = body.deviceName ?? '알 수 없는 기기';
      if (body.deviceType !== undefined) update.deviceType = body.deviceType ?? 'web';
      if (body.platform !== undefined) update.platform = body.platform ?? 'unknown';
      if (body.userAgent !== undefined) update.userAgent = body.userAgent ?? '';
      if (body.browserName !== undefined) update.browserName = body.browserName ?? null;
      if (body.browserVersion !== undefined) update.browserVersion = body.browserVersion ?? null;
      if (body.osName !== undefined) update.osName = body.osName ?? null;
      if (body.osVersion !== undefined) update.osVersion = body.osVersion ?? null;
      if (body.ipAddress !== undefined) update.ipAddress = body.ipAddress ?? null;
      if (body.regionName !== undefined) update.regionName = body.regionName ?? null;
      if (body.cityName !== undefined) update.cityName = body.cityName ?? null;
      if (body.countryName !== undefined) update.countryName = body.countryName ?? null;

      await db
        .collection<OptionalId<LoginSession>>('login_sessions')
        .updateOne({ userId: new ObjectId(authUserId), deviceId: authDeviceId }, { $set: update });

      return { ok: true };
    },
    {
      body: t.Object({
        deviceName: t.Optional(t.Union([t.String(), t.Null()])),
        deviceType: t.Optional(t.Union([t.String(), t.Null()])),
        platform: t.Optional(t.Union([t.String(), t.Null()])),
        userAgent: t.Optional(t.Union([t.String(), t.Null()])),
        browserName: t.Optional(t.Union([t.String(), t.Null()])),
        browserVersion: t.Optional(t.Union([t.String(), t.Null()])),
        osName: t.Optional(t.Union([t.String(), t.Null()])),
        osVersion: t.Optional(t.Union([t.String(), t.Null()])),
        ipAddress: t.Optional(t.Union([t.String(), t.Null()])),
        regionName: t.Optional(t.Union([t.String(), t.Null()])),
        cityName: t.Optional(t.Union([t.String(), t.Null()])),
        countryName: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  )
  .delete('/account/sessions/others', async ({ db, authUserId, query, headers, set }) => {
    const userId = new ObjectId(authUserId);
    const currentDeviceId = normalizeDeviceId(String(query.actorDeviceId ?? query.actor_device_id ?? headers['x-device-id'] ?? ''));

    if (!currentDeviceId || currentDeviceId === 'default') {
      set.status = 400;
      return { error: 'Current device id is required.' };
    }

    const now = new Date();
    const sessionsToRevoke = await db
      .collection<OptionalId<LoginSession>>('login_sessions')
      .find({ userId, deviceId: { $ne: currentDeviceId }, isActive: { $ne: false } }, { projection: { deviceId: 1 } })
      .toArray();
    const result = await db.collection<OptionalId<LoginSession>>('login_sessions').updateMany(
      { userId, deviceId: { $in: sessionsToRevoke.map((session) => session.deviceId) } },
      {
        $set: {
          isActive: false,
          revokedAt: now,
          updatedAt: now,
        },
      }
    );

    for (const session of sessionsToRevoke) {
      notifySessionRevoked(authUserId, session.deviceId);
    }

    return { ok: true, revokedCount: result.modifiedCount };
  })
  .delete(
    '/account/sessions/:deviceId',
    async ({ db, authUserId, params, query, headers, set }) => {
      const userId = new ObjectId(authUserId);
      const deviceId = normalizeDeviceId(params.deviceId);
      const currentDeviceId = normalizeDeviceId(String(query.actorDeviceId ?? query.actor_device_id ?? headers['x-device-id'] ?? ''));

      if (!deviceId || deviceId === 'default') {
        set.status = 400;
        return { error: 'Invalid device id.' };
      }

      if (deviceId === currentDeviceId) {
        set.status = 400;
        return { error: 'Current session cannot be revoked here.' };
      }

      const now = new Date();
      await db.collection<OptionalId<LoginSession>>('login_sessions').updateOne(
        { userId, deviceId },
        {
          $set: {
            isActive: false,
            revokedAt: now,
            updatedAt: now,
          },
        }
      );
      notifySessionRevoked(authUserId, deviceId);

      return { ok: true };
    },
    {
      params: t.Object({
        deviceId: t.String({ minLength: 1 }),
      }),
    }
  )
  .get('/preferences/timer', async ({ db, authUserId }) => {
    const userId = new ObjectId(authUserId);
    const preferences = await ensureTimerPreferences(db, userId);

    return {
      preferences: {
        pomodoroFocusMinutes: preferences.pomodoroFocusMinutes,
        pomodoroBreakMinutes: preferences.pomodoroBreakMinutes,
        pomodoroLongBreakMinutes: preferences.pomodoroLongBreakMinutes,
        pomodoroLongBreakInterval: preferences.pomodoroLongBreakInterval,
        pomodoroAlarmOn: preferences.pomodoroAlarmOn,
        pomodoroFocusWhiteNoise: preferences.pomodoroFocusWhiteNoise,
        pomodoroBreakWhiteNoise: preferences.pomodoroBreakWhiteNoise,
        pomodoroFocusWhiteNoiseVolume: preferences.pomodoroFocusWhiteNoiseVolume,
        pomodoroBreakWhiteNoiseVolume: preferences.pomodoroBreakWhiteNoiseVolume,
        whiteNoiseVolume: preferences.whiteNoiseVolume,
      },
    };
  })
  .get('/settings/summary', async ({ db, authUserId }) => {
    const userId = new ObjectId(authUserId);
    const [subjects, preferences, activeSessionCount] = await Promise.all([
      ensureSubjects(db, userId),
      ensureTimerPreferences(db, userId),
      db.collection<OptionalId<LoginSession>>('login_sessions').countDocuments({ userId, isActive: { $ne: false } }),
    ]);

    return {
      subjectCount: subjects.length,
      activeSessionCount,
      timerPreferences: {
        pomodoroFocusMinutes: preferences.pomodoroFocusMinutes,
        pomodoroBreakMinutes: preferences.pomodoroBreakMinutes,
        pomodoroLongBreakMinutes: preferences.pomodoroLongBreakMinutes,
        pomodoroLongBreakInterval: preferences.pomodoroLongBreakInterval,
        pomodoroAlarmOn: preferences.pomodoroAlarmOn,
        pomodoroFocusWhiteNoise: preferences.pomodoroFocusWhiteNoise,
        pomodoroBreakWhiteNoise: preferences.pomodoroBreakWhiteNoise,
        pomodoroFocusWhiteNoiseVolume: preferences.pomodoroFocusWhiteNoiseVolume,
        pomodoroBreakWhiteNoiseVolume: preferences.pomodoroBreakWhiteNoiseVolume,
        whiteNoiseVolume: preferences.whiteNoiseVolume,
      },
    };
  })
  .put(
    '/preferences/timer',
    async ({ db, authUserId, body }) => {
      const userId = new ObjectId(authUserId);
      const now = new Date();
      const preferences = normalizeTimerPreferences(body);

      await db.collection<OptionalId<TimerPreferences>>('timer_preferences').updateOne(
        { userId },
        {
          $set: { ...preferences, updatedAt: now },
          $setOnInsert: { userId, createdAt: now },
        },
        { upsert: true }
      );

      return { preferences };
    },
    {
      body: t.Object({
        pomodoroFocusMinutes: t.Number({ minimum: 1, maximum: 180 }),
        pomodoroBreakMinutes: t.Number({ minimum: 1, maximum: 180 }),
        pomodoroLongBreakMinutes: t.Optional(t.Number({ minimum: 1, maximum: 180 })),
        pomodoroLongBreakInterval: t.Optional(t.Number({ minimum: 2, maximum: 12 })),
        pomodoroAlarmOn: t.Optional(t.Boolean()),
        pomodoroFocusWhiteNoise: t.Optional(t.String()),
        pomodoroBreakWhiteNoise: t.Optional(t.String()),
        pomodoroFocusWhiteNoiseVolume: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
        pomodoroBreakWhiteNoiseVolume: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
        whiteNoiseVolume: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
      }),
    }
  )
  .get(
    '/subjects',
    async ({ db, authUserId, query }) => {
      const userId = new ObjectId(authUserId);
      const subjects = await ensureSubjects(db, userId);
      const totals = await buildSubjectTotals(db, userId, getKstDayRange());
      const activeOnly = query.activeOnly === 'true' || query.activeOnly === '1';
      const visibleSubjects = activeOnly ? subjects.filter((subject) => subject.isActive !== false) : subjects;

      return {
        items: visibleSubjects.map((subject) => ({
          subjectId: subject.subjectId,
          label: subject.label,
          color: subject.color ?? defaultSubjects.find((item) => item.subjectId === subject.subjectId)?.color ?? '#6EE7B7',
          icon: subject.icon ?? defaultSubjects.find((item) => item.subjectId === subject.subjectId)?.icon ?? 'menu-book',
          isActive: subject.isActive ?? true,
          totalSeconds: totals.get(subject.subjectId) ?? 0,
        })),
      };
    },
    {
      query: t.Object({
        activeOnly: t.Optional(t.String()),
      }),
    }
  )
  .post(
    '/subjects',
    async ({ db, authUserId, body, set }) => {
      const userId = new ObjectId(authUserId);
      const now = new Date();
      const subjects = await ensureSubjects(db, userId);
      const normalizedLabel = normalizeSubjectLabel(body.label);
      const conflict = findSubjectLabelConflict(subjects, normalizedLabel);

      if (conflict) {
        set.status = 409;
        return { error: 'A subject with that name already exists.' };
      }

      const subjectId = makeSubjectId(normalizedLabel, now);
      const subjectsCollection = db.collection<OptionalId<Subject>>('subjects');
      const count = subjects.length;
      const defaultStyle = defaultSubjects[count % defaultSubjects.length] ?? defaultSubjects[0];
      await subjectsCollection.updateOne(
        { userId, subjectId },
        {
          $set: { label: normalizedLabel, updatedAt: now },
          $setOnInsert: {
            userId,
            subjectId,
            color: body.color ?? defaultStyle.color,
            icon: body.icon ?? defaultStyle.icon,
            isActive: body.isActive ?? true,
            order: count,
            createdAt: now,
          },
        },
        { upsert: true }
      );

      return { subjectId, label: normalizedLabel };
    },
    {
      body: t.Object({
        label: t.String({ minLength: 1, maxLength: 20 }),
        color: t.Optional(t.String({ minLength: 4, maxLength: 16 })),
        icon: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
        isActive: t.Optional(t.Boolean()),
      }),
    }
  )
  .patch(
    '/subjects/:subjectId',
    async ({ db, authUserId, params, body, set }) => {
      const userId = new ObjectId(authUserId);
      const subjects = await ensureSubjects(db, userId);
      const updates: Partial<Pick<Subject, 'label' | 'color' | 'icon' | 'isActive' | 'updatedAt'>> = {
        updatedAt: new Date(),
      };
      if (body.label !== undefined) {
        const normalizedLabel = normalizeSubjectLabel(body.label);
        const conflict = findSubjectLabelConflict(subjects, normalizedLabel, params.subjectId);
        if (conflict) {
          set.status = 409;
          return { error: 'A subject with that name already exists.' };
        }
        updates.label = normalizedLabel;
      }
      if (body.color !== undefined) updates.color = body.color;
      if (body.icon !== undefined) updates.icon = body.icon;
      if (body.isActive !== undefined) updates.isActive = body.isActive;

      const result = await db.collection<OptionalId<Subject>>('subjects').updateOne(
        { userId, subjectId: params.subjectId },
        { $set: updates }
      );

      if (result.matchedCount === 0) {
        set.status = 404;
        return { error: 'Subject not found.' };
      }

      return { ok: true };
    },
    {
      params: t.Object({ subjectId: t.String() }),
      body: t.Object({
        label: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
        color: t.Optional(t.String({ minLength: 4, maxLength: 16 })),
        icon: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
        isActive: t.Optional(t.Boolean()),
      }),
    }
  )
  .delete(
    '/subjects/:subjectId',
    async ({ db, authUserId, params, set }) => {
      const userId = new ObjectId(authUserId);
      await ensureSubjects(db, userId);
      const subjects = db.collection<OptionalId<Subject>>('subjects');
      const count = await subjects.countDocuments({ userId });
      if (count <= 1) {
        set.status = 400;
        return { error: 'At least one subject is required.' };
      }

      const result = await subjects.deleteOne({ userId, subjectId: params.subjectId });
      if (result.deletedCount === 0) {
        set.status = 404;
        return { error: 'Subject not found.' };
      }

      await normalizeSubjectOrder(db, userId);
      return { ok: true };
    },
    {
      params: t.Object({ subjectId: t.String() }),
    }
  )
  .put(
    '/subjects/order',
    async ({ db, authUserId, body }) => {
      const userId = new ObjectId(authUserId);
      await ensureSubjects(db, userId);
      const subjects = db.collection<OptionalId<Subject>>('subjects');
      const now = new Date();

      await Promise.all(
        body.subjectIds.map((subjectId, index) =>
          subjects.updateOne({ userId, subjectId }, { $set: { order: index, updatedAt: now } })
        )
      );

      return { ok: true };
    },
    {
      body: t.Object({
        subjectIds: t.Array(t.String(), { minItems: 1 }),
      }),
    }
  )
  .get('/goals', async ({ db, authUserId }) => {
    const userId = new ObjectId(authUserId);
    const goals = await ensureGoals(db, userId);
    const weekly = await sumStoppedSeconds(db, userId, getKstWeekRange());
    const monthly = await sumStoppedSeconds(db, userId, getKstMonthRange());

    return {
      items: goals.map((goal) => {
        const currentSeconds = goal.period === 'weekly' ? weekly : monthly;
        return {
          goalId: goal.goalId,
          title: goal.title,
          targetSeconds: goal.targetSeconds,
          currentSeconds,
          progress: getProgress(currentSeconds, goal.targetSeconds),
          period: goal.period,
        };
      }),
    };
  })
  .post(
    '/goals',
    async ({ db, authUserId, body }) => {
      const userId = new ObjectId(authUserId);
      const goals = db.collection<OptionalId<Goal>>('goals');
      const now = new Date();
      const count = await goals.countDocuments({ userId });
      const goalId = makeGoalId(body.title, now);

      await goals.insertOne({
        userId,
        goalId,
        title: body.title.trim(),
        targetSeconds: body.targetSeconds,
        period: body.period,
        order: count,
        createdAt: now,
        updatedAt: now,
      });

      return { goalId };
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 60 }),
        targetSeconds: t.Number({ minimum: 60 }),
        period: t.Union([t.Literal('weekly'), t.Literal('monthly')]),
      }),
    }
  )
  .patch(
    '/goals/:goalId',
    async ({ db, authUserId, params, body, set }) => {
      const userId = new ObjectId(authUserId);
      await ensureGoals(db, userId);

      const update: Partial<Pick<Goal, 'title' | 'targetSeconds'>> & { updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (body.title !== undefined) {
        update.title = body.title.trim();
      }
      if (body.targetSeconds !== undefined) {
        update.targetSeconds = body.targetSeconds;
      }

      const result = await db
        .collection<OptionalId<Goal>>('goals')
        .updateOne({ userId, goalId: params.goalId }, { $set: update });

      if (result.matchedCount === 0) {
        set.status = 404;
        return { error: 'Goal not found.' };
      }

      return { ok: true };
    },
    {
      params: t.Object({
        goalId: t.String(),
      }),
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1, maxLength: 60 })),
        targetSeconds: t.Optional(t.Number({ minimum: 60 })),
      }),
    }
  )
  .delete(
    '/goals/:goalId',
    async ({ db, authUserId, params, set }) => {
      const userId = new ObjectId(authUserId);
      const result = await db.collection<OptionalId<Goal>>('goals').deleteOne({ userId, goalId: params.goalId });

      if (result.deletedCount === 0) {
        set.status = 404;
        return { error: 'Goal not found.' };
      }

      await normalizeGoalOrder(db, userId);
      return { ok: true };
    },
    {
      params: t.Object({
        goalId: t.String(),
      }),
    }
  )
  .put(
    '/goals/order',
    async ({ db, authUserId, body }) => {
      const userId = new ObjectId(authUserId);
      await ensureGoals(db, userId);
      const goals = db.collection<OptionalId<Goal>>('goals');
      const now = new Date();

      await Promise.all(
        body.goalIds.map((goalId, index) => goals.updateOne({ userId, goalId }, { $set: { order: index, updatedAt: now } }))
      );

      return { ok: true };
    },
    {
      body: t.Object({
        goalIds: t.Array(t.String(), { minItems: 1 }),
      }),
    }
  )
  .get('/stats/weekly-activity', async ({ db, authUserId }) => {
    const userId = new ObjectId(authUserId);
    const days = getKstWeekDays();
    const totals = await buildDailyTotals(db, userId, days[0].start, days[6].end);
    const maxSeconds = Math.max(1, ...days.map((day) => totals.get(day.key) ?? 0));

    return {
      totalSeconds: days.reduce((sum, day) => sum + (totals.get(day.key) ?? 0), 0),
      items: days.map((day) => {
        const totalSeconds = totals.get(day.key) ?? 0;
        return {
          key: day.key,
          label: day.label,
          totalSeconds,
          ratio: totalSeconds / maxSeconds,
          isToday: day.isToday,
        };
      }),
    };
  })
  .get('/stats/hourly-activity', async ({ db, authUserId }) => {
    const userId = new ObjectId(authUserId);
    const dayRange = getKstDayRange();
    const totals = await buildHourlyTotalsForRange(db, userId, dayRange.start, dayRange.end);
    const maxSeconds = Math.max(1, ...Array.from(totals.values()));
    const items = Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, '0');
      const totalSeconds = totals.get(key) ?? 0;
      return {
        key,
        hour,
        label: `${hour}시`,
        totalSeconds,
        ratio: totalSeconds / maxSeconds,
      };
    });

    return {
      dateKey: getKstDateKey(new Date()),
      totalSeconds: items.reduce((sum, item) => sum + item.totalSeconds, 0),
      items,
    };
  })
  .get(
    '/stats/records-range',
    async ({ db, authUserId, query }) => {
      const userId = new ObjectId(authUserId);
      const anchor = parseAnchorDate(query.anchor);
      const range = normalizeRange(query.range);

      if (range === 'daily') {
        const dayRange = getKstDayRange(anchor);
        const totals = await buildHourlyTotalsForRange(db, userId, dayRange.start, dayRange.end);
        const maxSeconds = Math.max(1, ...Array.from(totals.values()));
        const items = Array.from({ length: 24 }, (_, hour) => {
          const key = String(hour).padStart(2, '0');
          const totalSeconds = totals.get(key) ?? 0;
          return {
            key,
            label: `${hour}시`,
            totalSeconds,
            ratio: totalSeconds / maxSeconds,
            isToday: isSameKstDate(anchor, new Date()),
          };
        });

        return {
          range,
          rangeLabel: formatKstDayLabel(anchor),
          totalSeconds: items.reduce((sum, item) => sum + item.totalSeconds, 0),
          items,
        };
      }

      if (range === 'monthly') {
        const days = getKstMonthDaysFlat(anchor);
        const totals = await buildDailyTotals(db, userId, days[0].start, days[days.length - 1].end);
        const maxSeconds = Math.max(1, ...days.map((day) => totals.get(day.key) ?? 0));
        const items = days.map((day) => {
          const totalSeconds = totals.get(day.key) ?? 0;
          return {
            key: day.key,
            label: String(day.day),
            totalSeconds,
            ratio: totalSeconds / maxSeconds,
            isToday: day.isToday,
          };
        });

        return {
          range,
          rangeLabel: formatKstMonthLabel(anchor),
          totalSeconds: items.reduce((sum, item) => sum + item.totalSeconds, 0),
          items,
        };
      }

      if (range === 'yearly') {
        const yearRange = getKstYearRange(anchor);
        const totals = await buildMonthlyTotals(db, userId, yearRange.start, yearRange.end);
        const maxSeconds = Math.max(1, ...Array.from(totals.values()));
        const items = Array.from({ length: 12 }, (_, index) => {
          const month = index + 1;
          const key = `${formatKstYear(anchor)}-${String(month).padStart(2, '0')}`;
          const totalSeconds = totals.get(key) ?? 0;
          return {
            key,
            label: `${month}월`,
            totalSeconds,
            ratio: totalSeconds / maxSeconds,
            isToday: false,
          };
        });

        return {
          range,
          rangeLabel: `${formatKstYear(anchor)}년`,
          totalSeconds: items.reduce((sum, item) => sum + item.totalSeconds, 0),
          items,
        };
      }

      const weekDays = getKstWeekDays(anchor);
      const totals = await buildDailyTotals(db, userId, weekDays[0].start, weekDays[6].end);
      const maxSeconds = Math.max(1, ...weekDays.map((day) => totals.get(day.key) ?? 0));
      const items = weekDays.map((day) => {
        const totalSeconds = totals.get(day.key) ?? 0;
        return {
          key: day.key,
          label: day.label,
          totalSeconds,
          ratio: totalSeconds / maxSeconds,
          isToday: day.isToday,
        };
      });

      return {
        range,
        rangeLabel: `${formatKstShortDate(weekDays[0].key)} - ${formatKstShortDate(weekDays[6].key)}`,
        totalSeconds: items.reduce((sum, item) => sum + item.totalSeconds, 0),
        items,
      };
    },
    {
      query: t.Object({
        range: t.Optional(t.Union([t.Literal('daily'), t.Literal('weekly'), t.Literal('monthly'), t.Literal('yearly')])),
        anchor: t.Optional(t.String()),
      }),
    }
  )
  .get(
    '/stats/recent-sessions',
    async ({ db, authUserId, query }) => {
      const userId = new ObjectId(authUserId);
      const subjects = await ensureSubjects(db, userId);
      const subjectLabels = new Map(subjects.map((subject) => [subject.subjectId, subject.label]));
      const limit = clampLimit(query.limit, 1, 50, 12);
      const sessions = await buildRecentSessions(db, userId, subjectLabels, limit);
      return { items: sessions };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
      }),
    }
  )
  .get('/stats/streak', async ({ db, authUserId }) => {
    const userId = new ObjectId(authUserId);
    const streak = await buildStreak(db, userId);

    return {
      streakDays: streak.current,
      bestStreakDays: streak.best,
      activeDates: streak.activeDates,
      activeDays: streak.activeDays,
      minimumDailySeconds: STREAK_MIN_DAILY_SECONDS,
    };
  })
  .get(
    '/stats/records',
    async ({ db, authUserId, query }) => {
    const userId = new ObjectId(authUserId);
    const subjects = await ensureSubjects(db, userId);
    const subjectLabels = new Map(subjects.map((subject) => [subject.subjectId, subject.label]));
    const weekAnchor = parseAnchorDate(query.weekAnchor);
    const monthAnchor = parseAnchorDate(query.monthAnchor);
    const weekDays = getKstWeekDays(weekAnchor);
    const monthDays = getKstMonthDays(monthAnchor);
    const weekTotals = await buildDailyTotals(db, userId, weekDays[0].start, weekDays[6].end);
    const previousWeekRange = getKstWeekRange(new Date(weekDays[0].start.getTime() - 24 * 60 * 60 * 1000));
    const previousWeekTotalSeconds = await sumStoppedSeconds(db, userId, previousWeekRange);
    const monthTotals = await buildDailyTotals(db, userId, monthDays[0].start, monthDays[monthDays.length - 1].end);
    const hourlyTotals = await buildHourlyTotals(db, userId, weekDays[0].start, weekDays[6].end);
    const overview = await buildRecordOverview(db, userId);
    const recentSessions = await buildRecentSessions(db, userId, subjectLabels, 8);
    const streak = await buildStreak(db, userId);
    const maxWeekSeconds = Math.max(1, ...weekDays.map((day) => weekTotals.get(day.key) ?? 0));
    const maxHourSeconds = Math.max(1, ...Array.from(hourlyTotals.values()));

    return {
      overview: {
        totalSeconds: overview.totalSeconds,
        sessionCount: overview.sessionCount,
        streakDays: streak.current,
        bestStreakDays: streak.best,
      },
      week: {
        rangeLabel: `${formatKstShortDate(weekDays[0].key)} - ${formatKstShortDate(weekDays[6].key)}`,
        totalSeconds: weekDays.reduce((sum, day) => sum + (weekTotals.get(day.key) ?? 0), 0),
        previousWeekTotalSeconds,
        items: weekDays.map((day) => {
          const totalSeconds = weekTotals.get(day.key) ?? 0;
          return {
            key: day.key,
            label: day.label,
            dateLabel: formatKstShortDate(day.key),
            totalSeconds,
            ratio: totalSeconds / maxWeekSeconds,
            isToday: day.isToday,
          };
        }),
      },
      month: {
        label: formatKstMonthLabel(monthAnchor),
        days: monthDays.map((day) => ({
          key: day.key,
          day: day.day,
          weekday: day.weekday,
          isCurrentMonth: day.isCurrentMonth,
          isToday: day.isToday,
          totalSeconds: monthTotals.get(day.key) ?? 0,
        })),
      },
      hourlyPattern: {
        days: weekDays.map((day, index) => ({
          key: day.key,
          label: day.label,
          dateLabel: formatKstShortDate(day.key),
          weekday: index,
          slots: Array.from({ length: 24 }, (_, hour) => {
            const totalSeconds = hourlyTotals.get(`${day.key}:${String(hour).padStart(2, '0')}`) ?? 0;
            return { hour, totalSeconds, ratio: totalSeconds / maxHourSeconds };
          }),
        })),
      },
      recentSessions,
    };
    },
    {
      query: t.Object({
        weekAnchor: t.Optional(t.String()),
        monthAnchor: t.Optional(t.String()),
      }),
    }
  );

async function ensureSubjects(db: Db, userId: ObjectId) {
  const subjects = db.collection<OptionalId<Subject>>('subjects');
  const existing = await subjects.find({ userId }).sort({ order: 1 }).toArray();
  if (existing.length > 0) {
    const uniqueSubjects: OptionalId<Subject>[] = [];
    const seenSubjectIds = new Set<string>();

    for (const subject of existing) {
      if (seenSubjectIds.has(subject.subjectId)) {
        continue;
      }

      seenSubjectIds.add(subject.subjectId);
      uniqueSubjects.push(subject);
    }

    return uniqueSubjects;
  }

  const now = new Date();
  await subjects.insertMany(
    defaultSubjects.map((subject) => ({
      ...subject,
      userId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }))
  );

  return subjects.find({ userId }).sort({ order: 1 }).toArray();
}

async function normalizeSubjectOrder(db: Db, userId: ObjectId) {
  const subjects = db.collection<OptionalId<Subject>>('subjects');
  const existing = await subjects.find({ userId }).sort({ order: 1 }).toArray();
  await Promise.all(
    existing.map((subject, index) =>
      subjects.updateOne({ _id: subject._id }, { $set: { order: index, updatedAt: new Date() } })
    )
  );
}

async function normalizeGoalOrder(db: Db, userId: ObjectId) {
  const goals = db.collection<OptionalId<Goal>>('goals');
  const existing = await goals.find({ userId }).sort({ order: 1 }).toArray();
  await Promise.all(
    existing.map((goal, index) =>
      goals.updateOne({ _id: goal._id }, { $set: { order: index, updatedAt: new Date() } })
    )
  );
}

async function ensureGoals(db: Db, userId: ObjectId) {
  const goals = db.collection<OptionalId<Goal>>('goals');
  const existing = await goals.find({ userId }).sort({ order: 1 }).toArray();
  if (existing.length > 0) {
    return existing;
  }

  const now = new Date();
  await goals.insertMany(
    defaultGoals.map((goal) => ({
      ...goal,
      userId,
      createdAt: now,
      updatedAt: now,
    }))
  );

  return goals.find({ userId }).sort({ order: 1 }).toArray();
}

async function ensureTimerPreferences(db: Db, userId: ObjectId) {
  const preferences = db.collection<OptionalId<TimerPreferences>>('timer_preferences');
  const existing = await preferences.findOne({ userId });
  if (existing) {
    return {
      ...existing,
      ...normalizeTimerPreferences(existing),
    };
  }

  const now = new Date();
  const document = {
    userId,
    ...defaultTimerPreferences,
    createdAt: now,
    updatedAt: now,
  };
  const result = await preferences.insertOne(document);
  return { _id: result.insertedId, ...document };
}

function normalizeTimerPreferences(
  preferences: Partial<
    Pick<
      TimerPreferences,
      | 'pomodoroFocusMinutes'
      | 'pomodoroBreakMinutes'
      | 'pomodoroLongBreakMinutes'
      | 'pomodoroLongBreakInterval'
      | 'pomodoroAlarmOn'
      | 'pomodoroFocusWhiteNoise'
      | 'pomodoroBreakWhiteNoise'
      | 'pomodoroFocusWhiteNoiseVolume'
      | 'pomodoroBreakWhiteNoiseVolume'
      | 'whiteNoiseVolume'
    >
  >
) {
  return {
    pomodoroFocusMinutes: clampPreferenceMinutes(
      preferences.pomodoroFocusMinutes,
      defaultTimerPreferences.pomodoroFocusMinutes
    ),
    pomodoroBreakMinutes: clampPreferenceMinutes(
      preferences.pomodoroBreakMinutes,
      defaultTimerPreferences.pomodoroBreakMinutes
    ),
    pomodoroLongBreakMinutes: clampPreferenceMinutes(
      preferences.pomodoroLongBreakMinutes,
      defaultTimerPreferences.pomodoroLongBreakMinutes
    ),
    pomodoroLongBreakInterval: Math.max(
      2,
      Math.min(12, clampPreferenceMinutes(preferences.pomodoroLongBreakInterval, defaultTimerPreferences.pomodoroLongBreakInterval))
    ),
    pomodoroAlarmOn:
      typeof preferences.pomodoroAlarmOn === 'boolean'
        ? preferences.pomodoroAlarmOn
        : defaultTimerPreferences.pomodoroAlarmOn,
    pomodoroFocusWhiteNoise: normalizeWhiteNoise(preferences.pomodoroFocusWhiteNoise),
    pomodoroBreakWhiteNoise: normalizeWhiteNoise(preferences.pomodoroBreakWhiteNoise),
    pomodoroFocusWhiteNoiseVolume: clampRatio(
      preferences.pomodoroFocusWhiteNoiseVolume ?? preferences.whiteNoiseVolume,
      defaultTimerPreferences.pomodoroFocusWhiteNoiseVolume
    ),
    pomodoroBreakWhiteNoiseVolume: clampRatio(
      preferences.pomodoroBreakWhiteNoiseVolume ?? preferences.whiteNoiseVolume,
      defaultTimerPreferences.pomodoroBreakWhiteNoiseVolume
    ),
    whiteNoiseVolume: clampRatio(preferences.whiteNoiseVolume, defaultTimerPreferences.whiteNoiseVolume),
  };
}

function normalizeWhiteNoise(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : 'none';
}

function clampPreferenceMinutes(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(1, Math.min(180, Math.round(numeric)));
}

function clampRatio(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

async function buildSubjectTotals(db: Db, userId: ObjectId, range: { start: Date; end: Date }) {
  const sessions = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .aggregate<{ stoppedAtResolved: Date | null; durationSeconds: number; subjectId?: string | null }>([
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
          stoppedAtResolved: { $gt: range.start },
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $project: {
          stoppedAtResolved: 1,
          durationSeconds: 1,
          subjectId: 1,
        },
      },
    ])
    .toArray();

  const totals = new Map<string, number>();
  for (const session of sessions) {
    const seconds = getSessionOverlapSeconds(session, range.start, range.end);
    if (seconds > 0) {
      const subjectId = session.subjectId ?? 'korean';
      totals.set(subjectId, (totals.get(subjectId) ?? 0) + seconds);
    }
  }

  return totals;
}

async function buildDailyTotals(db: Db, userId: ObjectId, start: Date, end: Date) {
  const sessions = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .aggregate<{ stoppedAtResolved: Date | null; durationSeconds: number }>([
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
          stoppedAtResolved: { $gt: start },
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $project: {
          stoppedAtResolved: 1,
          durationSeconds: 1,
        },
      },
    ])
    .toArray();

  return distributeSessionsByDay(sessions, start, end);
}

async function buildHourlyTotals(db: Db, userId: ObjectId, start: Date, end: Date) {
  const sessions = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .aggregate<{ stoppedAtResolved: Date | null; durationSeconds: number }>([
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
          stoppedAtResolved: { $gt: start },
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $project: {
          stoppedAtResolved: 1,
          durationSeconds: 1,
        },
      },
    ])
    .toArray();

  return distributeSessionsByHour(sessions, start, end, 'day-hour');
}

async function buildRecordOverview(db: Db, userId: ObjectId) {
  const totals = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .aggregate<{ totalSeconds: number; sessionCount: number }>([
      {
        $match: {
          userId,
          status: 'stopped',
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: '$userId',
          totalSeconds: { $sum: '$durationSeconds' },
          sessionCount: { $sum: 1 },
        },
      },
    ])
    .toArray();

  return {
    totalSeconds: totals[0]?.totalSeconds ?? 0,
    sessionCount: totals[0]?.sessionCount ?? 0,
  };
}

async function buildRecentSessions(db: Db, userId: ObjectId, subjectLabels: Map<string, string>, limit = 8) {
  const sessions = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .find({ userId, status: 'stopped', durationSeconds: { $gt: 0 } })
    .sort({ stoppedAt: -1, updatedAt: -1 })
    .limit(limit)
    .toArray();

  return sessions.map((session) => ({
    sessionId: session._id.toString(),
    subjectId: session.subjectId ?? 'korean',
    subjectLabel: subjectLabels.get(session.subjectId ?? 'korean') ?? '국어',
    durationSeconds: session.durationSeconds ?? 0,
    startedAt: session.startedAt?.toISOString(),
    stoppedAt: session.stoppedAt?.toISOString(),
  }));
}

async function buildMonthlyTotals(db: Db, userId: ObjectId, start: Date, end: Date) {
  const totals = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .aggregate<{ _id: string; totalSeconds: number }>([
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
          stoppedAtResolved: { $gte: start, $lt: end },
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              date: '$stoppedAtResolved',
              format: '%Y-%m',
              timezone: 'Asia/Seoul',
            },
          },
          totalSeconds: { $sum: '$durationSeconds' },
        },
      },
    ])
    .toArray();

  return new Map(totals.map((item) => [item._id, item.totalSeconds]));
}

async function buildHourlyTotalsForRange(db: Db, userId: ObjectId, start: Date, end: Date) {
  const sessions = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .aggregate<{ stoppedAtResolved: Date | null; durationSeconds: number }>([
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
          stoppedAtResolved: { $gt: start },
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $project: {
          stoppedAtResolved: 1,
          durationSeconds: 1,
        },
      },
    ])
    .toArray();

  return distributeSessionsByHour(sessions, start, end, 'hour');
}

function distributeSessionsByHour(
  sessions: { stoppedAtResolved: Date | null; durationSeconds: number }[],
  rangeStart: Date,
  rangeEnd: Date,
  keyMode: 'hour' | 'day-hour'
) {
  const totals = new Map<string, number>();
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();

  for (const session of sessions) {
    if (!session.stoppedAtResolved || session.durationSeconds <= 0) {
      continue;
    }

    const stoppedAtMs = session.stoppedAtResolved.getTime();
    if (!Number.isFinite(stoppedAtMs)) {
      continue;
    }

    const durationMs = Math.max(0, Math.floor(session.durationSeconds) * 1000);
    const sessionStartMs = stoppedAtMs - durationMs;
    let cursorMs = Math.max(sessionStartMs, rangeStartMs);
    const clippedEndMs = Math.min(stoppedAtMs, rangeEndMs);

    while (cursorMs < clippedEndMs) {
      const nextHourMs = getNextHourBoundaryMs(cursorMs);
      const segmentEndMs = Math.min(nextHourMs, clippedEndMs);
      const segmentSeconds = Math.max(0, Math.round((segmentEndMs - cursorMs) / 1000));

      if (segmentSeconds > 0) {
        const key = keyMode === 'hour' ? getKstHourKey(new Date(cursorMs)) : getKstDayHourKey(new Date(cursorMs));
        totals.set(key, (totals.get(key) ?? 0) + segmentSeconds);
      }

      cursorMs = segmentEndMs;
    }
  }

  return totals;
}

function getNextHourBoundaryMs(timestampMs: number) {
  const date = new Date(timestampMs);
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(date.getUTCHours() + 1);
  return date.getTime();
}

function getKstHourKey(date: Date) {
  const kstDate = new Date(date.getTime() + KST_OFFSET_MS);
  return String(kstDate.getUTCHours()).padStart(2, '0');
}

function getKstDayHourKey(date: Date) {
  return `${getKstDateKey(date)}:${getKstHourKey(date)}`;
}

async function buildStreak(db: Db, userId: ObjectId) {
  const sessions = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .aggregate<{ stoppedAtResolved: Date | null; durationSeconds: number }>([
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
          stoppedAtResolved: { $ne: null },
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $project: {
          stoppedAtResolved: 1,
          durationSeconds: 1,
        },
      },
    ])
    .toArray();
  const dailyTotals = distributeSessionsByDay(sessions, new Date(0), new Date(8640000000000000));
  const activeDays = Array.from(dailyTotals.entries())
    .filter(([, totalSeconds]) => totalSeconds >= STREAK_MIN_DAILY_SECONDS)
    .map(([key, totalSeconds]) => ({ _id: key, totalSeconds }))
    .sort((a, b) => a._id.localeCompare(b._id));

  const activeDateSet = new Set(activeDays.map((item) => item._id));
  let current = 0;
  const todayKey = getKstDateKey(new Date());
  let cursor = activeDateSet.has(todayKey) ? todayKey : addKstDateDays(todayKey, -1);
  while (activeDateSet.has(cursor)) {
    current += 1;
    cursor = addKstDateDays(cursor, -1);
  }

  let best = 0;
  let running = 0;
  let previousKey: string | null = null;
  for (const item of activeDays) {
    if (previousKey && item._id !== addKstDateDays(previousKey, 1)) {
      running = 0;
    }

    running += 1;
    best = Math.max(best, running);
    previousKey = item._id;
  }

  return {
    current,
    best,
    activeDates: activeDays.map((item) => item._id),
    activeDays: activeDays.map((item) => ({ date: item._id, totalSeconds: item.totalSeconds })),
  };
}

function addKstDateDays(key: string, days: number) {
  const [year, month, day] = key.split('-').map(Number);
  if (!year || !month || !day) {
    return key;
  }

  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

async function sumStoppedSeconds(db: Db, userId: ObjectId, range: { start: Date; end: Date }) {
  const sessions = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .aggregate<{ stoppedAtResolved: Date | null; durationSeconds: number }>([
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
          stoppedAtResolved: { $gt: range.start },
          durationSeconds: { $gt: 0 },
        },
      },
      {
        $project: {
          stoppedAtResolved: 1,
          durationSeconds: 1,
        },
      },
    ])
    .toArray();

  return sessions.reduce((sum, session) => sum + getSessionOverlapSeconds(session, range.start, range.end), 0);
}

function distributeSessionsByDay(
  sessions: { stoppedAtResolved: Date | null; durationSeconds: number }[],
  rangeStart: Date,
  rangeEnd: Date
) {
  const totals = new Map<string, number>();
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();

  for (const session of sessions) {
    const bounds = getClippedSessionBounds(session, rangeStartMs, rangeEndMs);
    if (!bounds) {
      continue;
    }

    let cursorMs = bounds.startMs;
    while (cursorMs < bounds.endMs) {
      const nextDayMs = getNextKstDayBoundaryMs(cursorMs);
      const segmentEndMs = Math.min(nextDayMs, bounds.endMs);
      const segmentSeconds = Math.max(0, Math.round((segmentEndMs - cursorMs) / 1000));

      if (segmentSeconds > 0) {
        const key = getKstDateKey(new Date(cursorMs));
        totals.set(key, (totals.get(key) ?? 0) + segmentSeconds);
      }

      cursorMs = segmentEndMs;
    }
  }

  return totals;
}

function getSessionOverlapSeconds(
  session: { stoppedAtResolved: Date | null; durationSeconds: number },
  rangeStart: Date,
  rangeEnd: Date
) {
  const bounds = getClippedSessionBounds(session, rangeStart.getTime(), rangeEnd.getTime());
  return bounds ? Math.max(0, Math.round((bounds.endMs - bounds.startMs) / 1000)) : 0;
}

function getClippedSessionBounds(
  session: { stoppedAtResolved: Date | null; durationSeconds: number },
  rangeStartMs: number,
  rangeEndMs: number
) {
  if (!session.stoppedAtResolved || session.durationSeconds <= 0) {
    return null;
  }

  const stoppedAtMs = session.stoppedAtResolved.getTime();
  if (!Number.isFinite(stoppedAtMs)) {
    return null;
  }

  const durationMs = Math.max(0, Math.floor(session.durationSeconds) * 1000);
  const sessionStartMs = stoppedAtMs - durationMs;
  const startMs = Math.max(sessionStartMs, rangeStartMs);
  const endMs = Math.min(stoppedAtMs, rangeEndMs);

  if (startMs >= endMs) {
    return null;
  }

  return { startMs, endMs };
}

function getNextKstDayBoundaryMs(timestampMs: number) {
  const kstDate = new Date(timestampMs + KST_OFFSET_MS);
  kstDate.setUTCHours(0, 0, 0, 0);
  kstDate.setUTCDate(kstDate.getUTCDate() + 1);
  return kstDate.getTime() - KST_OFFSET_MS;
}

function makeSubjectId(label: string, now: Date) {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]/gu, '')
    .slice(0, 40);
  return normalized || `subject-${now.getTime()}`;
}

function normalizeSubjectLabel(label: string) {
  return label.trim().replace(/\s+/g, ' ');
}

function findSubjectLabelConflict(subjects: Pick<Subject, 'subjectId' | 'label'>[], label: string, excludeSubjectId?: string) {
  const normalizedLabel = normalizeSubjectLabel(label);
  const subjectId = makeSubjectId(normalizedLabel, new Date(0));

  return subjects.find(
    (subject) =>
      subject.subjectId !== excludeSubjectId &&
      (normalizeSubjectLabel(subject.label) === normalizedLabel || subject.subjectId === subjectId)
  );
}

function makeGoalId(title: string, now: Date) {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]/gu, '')
    .slice(0, 40);
  return normalized || `goal-${now.getTime()}`;
}

function normalizeRange(range: string | undefined) {
  if (range === 'daily' || range === 'monthly' || range === 'yearly' || range === 'weekly') {
    return range;
  }
  return 'weekly';
}

function parseAnchorDate(anchor?: string) {
  if (!anchor) {
    return new Date();
  }
  const parsed = new Date(anchor);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function clampLimit(value: string | undefined, min: number, max: number, fallback: number) {
  if (!value) {
    return fallback;
  }
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function getProgress(currentSeconds: number, targetSeconds: number) {
  if (targetSeconds <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((currentSeconds / targetSeconds) * 100));
}

function getKstDayRange(date = new Date()) {
  const kstMs = date.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  kstDate.setUTCHours(0, 0, 0, 0);
  const start = new Date(kstDate.getTime() - KST_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function getKstWeekRange(date = new Date()) {
  const weekStartKst = getKstWeekStart(date);
  const start = new Date(weekStartKst.getTime() - KST_OFFSET_MS);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

function getKstWeekDays(date = new Date()) {
  const weekStartKst = getKstWeekStart(date);
  const todayKey = getKstDateKey(new Date());

  return dayLabels.map((label, index) => {
    const dayStartKst = new Date(weekStartKst.getTime() + index * 24 * 60 * 60 * 1000);
    const start = new Date(dayStartKst.getTime() - KST_OFFSET_MS);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const key = dayStartKst.toISOString().slice(0, 10);

    return {
      key,
      label,
      start,
      end,
      isToday: key === todayKey,
    };
  });
}

function getKstMonthDays(date = new Date()) {
  const kstMs = date.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  const year = kstDate.getUTCFullYear();
  const month = kstDate.getUTCMonth();
  const firstDayKst = new Date(Date.UTC(year, month, 1));
  const calendarStart = new Date(firstDayKst.getTime() - firstDayKst.getUTCDay() * 24 * 60 * 60 * 1000);
  const todayKey = getKstDateKey(new Date());

  return Array.from({ length: 42 }, (_, index) => {
    const dayStartKst = new Date(calendarStart.getTime() + index * 24 * 60 * 60 * 1000);
    const start = new Date(dayStartKst.getTime() - KST_OFFSET_MS);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const key = dayStartKst.toISOString().slice(0, 10);

    return {
      key,
      day: dayStartKst.getUTCDate(),
      weekday: dayStartKst.getUTCDay(),
      start,
      end,
      isCurrentMonth: dayStartKst.getUTCMonth() === month,
      isToday: key === todayKey,
    };
  });
}

function getKstWeekStart(date: Date) {
  const kstMs = date.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  kstDate.setUTCHours(0, 0, 0, 0);
  const kstDay = kstDate.getUTCDay();
  const diff = (kstDay === 0 ? -6 : 1) - kstDay;
  return new Date(kstDate.getTime() + diff * 24 * 60 * 60 * 1000);
}

function getKstYearRange(date = new Date()) {
  const kstMs = date.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  const startKst = new Date(Date.UTC(kstDate.getUTCFullYear(), 0, 1));
  const endKst = new Date(Date.UTC(kstDate.getUTCFullYear() + 1, 0, 1));
  return {
    start: new Date(startKst.getTime() - KST_OFFSET_MS),
    end: new Date(endKst.getTime() - KST_OFFSET_MS),
  };
}

function getKstMonthDaysFlat(date = new Date()) {
  const kstMs = date.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  const year = kstDate.getUTCFullYear();
  const month = kstDate.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const todayKey = getKstDateKey(new Date());

  return Array.from({ length: lastDay }, (_, index) => {
    const day = index + 1;
    const dayStartKst = new Date(Date.UTC(year, month, day));
    const start = new Date(dayStartKst.getTime() - KST_OFFSET_MS);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const key = dayStartKst.toISOString().slice(0, 10);

    return {
      key,
      day,
      start,
      end,
      isToday: key === todayKey,
    };
  });
}

function getKstMonthRange(date = new Date()) {
  const kstMs = date.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  const startKst = new Date(Date.UTC(kstDate.getUTCFullYear(), kstDate.getUTCMonth(), 1));
  const endKst = new Date(Date.UTC(kstDate.getUTCFullYear(), kstDate.getUTCMonth() + 1, 1));
  return {
    start: new Date(startKst.getTime() - KST_OFFSET_MS),
    end: new Date(endKst.getTime() - KST_OFFSET_MS),
  };
}

function formatKstMonthLabel(date = new Date()) {
  const kstDate = new Date(date.getTime() + KST_OFFSET_MS);
  return `${kstDate.getUTCFullYear()}년 ${kstDate.getUTCMonth() + 1}월`;
}

function formatKstYear(date = new Date()) {
  const kstDate = new Date(date.getTime() + KST_OFFSET_MS);
  return kstDate.getUTCFullYear();
}

function formatKstDayLabel(date = new Date()) {
  const kstDate = new Date(date.getTime() + KST_OFFSET_MS);
  return `${kstDate.getUTCFullYear()}년 ${kstDate.getUTCMonth() + 1}월 ${kstDate.getUTCDate()}일`;
}

function formatKstShortDate(key: string) {
  const [, month, day] = key.split('-');
  return `${Number(month)}.${Number(day)}`;
}

function getKstDateKey(date: Date) {
  const kstDate = new Date(date.getTime() + KST_OFFSET_MS);
  kstDate.setUTCHours(0, 0, 0, 0);
  return kstDate.toISOString().slice(0, 10);
}

function isSameKstDate(a: Date, b: Date) {
  return getKstDateKey(a) === getKstDateKey(b);
}
