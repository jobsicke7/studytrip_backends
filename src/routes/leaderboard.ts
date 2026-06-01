import { Elysia } from 'elysia';
import { Db, ObjectId, OptionalId } from 'mongodb';

import type { Env } from '../config.js';
import type { StudySession, User } from '../types.js';
import { isLoginSessionActive, normalizeDeviceId } from '../utils/login-sessions.js';

type JwtService = {
  verify: (token?: string) => Promise<{ sub?: string } | false>;
};

type LeaderboardSocket = {
  data: unknown;
  send: (data: string) => unknown;
  close?: () => unknown;
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

const developerEmails = new Set(['dev@timer.local', 'doh292929@gmail.com']);

function isDeveloperUser(user: User) {
  return user.provider === 'dev' || developerEmails.has(user.email);
}

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

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const weeklyLeaderboardSockets = new Set<LeaderboardSocket>();
let weeklyLeaderboardNotifyTimer: ReturnType<typeof setTimeout> | null = null;

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

export const leaderboardRoutes = new Elysia<'/leaderboard', AppSingleton>({ prefix: '/leaderboard' })
  .use(requireAuth())
  .get('/daily', async ({ db, authUserId }) => {
    return buildLeaderboard(db, authUserId, getKstDayRange());
  })
  .get('/weekly', async ({ db, authUserId }) => {
    return buildLeaderboard(db, authUserId, getKstWeekRange());
  })
  .ws('/weekly/events', {
    async open(ws) {
      weeklyLeaderboardSockets.add(ws);
      const data = ws.data as unknown as { db: Db; authUserId: string };
      const payload = await buildLeaderboard(data.db, data.authUserId, getKstWeekRange());
      ws.send(JSON.stringify({ type: 'weekly-leaderboard', payload }));
    },
    close(ws) {
      weeklyLeaderboardSockets.delete(ws);
    },
    message(ws, message) {
      if (message === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    },
  });

export function notifyWeeklyLeaderboardChanged(db: Db) {
  if (weeklyLeaderboardNotifyTimer) {
    clearTimeout(weeklyLeaderboardNotifyTimer);
  }

  weeklyLeaderboardNotifyTimer = setTimeout(() => {
    weeklyLeaderboardNotifyTimer = null;
    void broadcastWeeklyLeaderboard(db);
  }, 250);
}

async function broadcastWeeklyLeaderboard(db: Db) {
  const sockets = Array.from(weeklyLeaderboardSockets);
  await Promise.all(
    sockets.map(async (socket) => {
      try {
        const data = socket.data as unknown as { authUserId: string };
        const payload = await buildLeaderboard(db, data.authUserId, getKstWeekRange());
        socket.send(JSON.stringify({ type: 'weekly-leaderboard', payload }));
      } catch {
        weeklyLeaderboardSockets.delete(socket);
        socket.close?.();
      }
    })
  );
}

async function buildLeaderboard(
  db: Db,
  authUserId: string,
  range: { start: Date; end: Date }
) {
  const sessions = db.collection<OptionalId<StudySession>>('study_sessions');
  const results = await sessions.aggregate<{ userId: ObjectId; stoppedAtResolved: Date | null; durationSeconds: number }>([
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
        status: 'stopped',
        stoppedAtResolved: { $gt: range.start },
        durationSeconds: { $gt: 0 },
      },
    },
    {
      $project: {
        userId: 1,
        stoppedAtResolved: 1,
        durationSeconds: 1,
      },
    },
  ]).toArray();

  const totals = new Map<string, { userId: ObjectId; totalSeconds: number }>();
  for (const session of results) {
    const totalSeconds = getSessionOverlapSeconds(session, range);
    if (totalSeconds <= 0) {
      continue;
    }

    const key = session.userId.toString();
    const current = totals.get(key);
    totals.set(key, {
      userId: session.userId,
      totalSeconds: (current?.totalSeconds ?? 0) + totalSeconds,
    });
  }

  const activeRows = await buildActiveLeaderboardTotals(db, range);
  for (const activeRow of activeRows) {
    const key = activeRow.userId.toString();
    const current = totals.get(key);
    totals.set(key, {
      userId: activeRow.userId,
      totalSeconds: (current?.totalSeconds ?? 0) + activeRow.totalSeconds,
    });
  }
  const activeMap = new Map(activeRows.map((row) => [row.userId.toString(), row]));

  const allRankedTotals = Array.from(totals.values()).sort((a, b) => b.totalSeconds - a.totalSeconds);
  const userIds = Array.from(new Set(allRankedTotals.map((item) => item.userId.toString()))).map((id) => new ObjectId(id));
  const users = await db
    .collection<OptionalId<User>>('users')
    .find({ _id: { $in: userIds } })
    .toArray();
  const userMap = new Map(users.filter((user) => !isDeveloperUser(user)).map((user) => [user._id.toString(), user]));
  const validRankedTotals = allRankedTotals.filter((item) => userMap.has(item.userId.toString()));
  const rankedTotals = validRankedTotals.slice(0, 100);
  const myRankedRow = validRankedTotals.find((item) => item.userId.toString() === authUserId);

  const buildItem = (row: { userId: ObjectId; totalSeconds: number }, index: number) => {
    const user = userMap.get(row.userId.toString())!;
    return {
      rank: index + 1,
      userId: row.userId.toString(),
      name: user.name,
      avatarUrl: user?.avatarUrl,
      totalSeconds: row.totalSeconds,
      isRunning: activeMap.get(row.userId.toString())?.status === 'running',
      liveStartedAt: activeMap.get(row.userId.toString())?.status === 'running' ? new Date().toISOString() : undefined,
    };
  };

  const items = rankedTotals.map(buildItem);
  const myIndex = myRankedRow ? validRankedTotals.findIndex((item) => item.userId.toString() === authUserId) : -1;

  return {
    range,
    items,
    me: myRankedRow && myIndex >= 0 ? buildItem(myRankedRow, myIndex) : null,
  };
}

function getSessionOverlapSeconds(
  session: { stoppedAtResolved: Date | null; durationSeconds: number },
  range: { start: Date; end: Date }
) {
  if (!session.stoppedAtResolved || session.durationSeconds <= 0) {
    return 0;
  }

  const stoppedAtMs = session.stoppedAtResolved.getTime();
  if (!Number.isFinite(stoppedAtMs)) {
    return 0;
  }

  const sessionStartMs = stoppedAtMs - Math.max(0, Math.floor(session.durationSeconds) * 1000);
  const startMs = Math.max(sessionStartMs, range.start.getTime());
  const endMs = Math.min(stoppedAtMs, range.end.getTime());
  return startMs < endMs ? Math.max(0, Math.round((endMs - startMs) / 1000)) : 0;
}

async function buildActiveLeaderboardTotals(db: Db, range: { start: Date; end: Date }) {
  const now = new Date();
  const activeSessions = await db
    .collection<OptionalId<StudySession>>('study_sessions')
    .find({ status: { $in: ['running', 'paused'] } })
    .toArray();

  const totals = new Map<
    string,
    { userId: ObjectId; totalSeconds: number; status: 'running' | 'paused'; lastStartedAt?: Date }
  >();

  for (const session of activeSessions) {
    const totalSeconds = getActiveSessionOverlapSeconds(session, range, now);
    if (totalSeconds <= 0 && session.status !== 'running') {
      continue;
    }

    const key = session.userId.toString();
    const current = totals.get(key);
    const status = current?.status === 'running' || session.status === 'running' ? 'running' : 'paused';
    totals.set(key, {
      userId: session.userId,
      totalSeconds: (current?.totalSeconds ?? 0) + totalSeconds,
      status,
      lastStartedAt: session.status === 'running' ? session.lastStartedAt : current?.lastStartedAt,
    });
  }

  return Array.from(totals.values());
}

function getActiveSessionOverlapSeconds(session: StudySession, range: { start: Date; end: Date }, now: Date) {
  const accumulatedSeconds = session.accumulatedSeconds ?? 0;
  const currentSeconds =
    session.status === 'running'
      ? accumulatedSeconds + Math.max(0, Math.floor((now.getTime() - session.lastStartedAt.getTime()) / 1000))
      : accumulatedSeconds;

  const studySeconds = session.timerMode === 'pomodoro' ? getPomodoroFocusSeconds(currentSeconds, session.pomodoroFocusMinutes, session.pomodoroBreakMinutes) : currentSeconds;
  const endAt = session.status === 'running' ? now : session.lastRecordedAt;
  const syntheticSession = { stoppedAtResolved: endAt, durationSeconds: studySeconds };
  return getSessionOverlapSeconds(syntheticSession, range);
}

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
