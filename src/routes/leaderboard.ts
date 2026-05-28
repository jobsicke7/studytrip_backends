import { Elysia } from 'elysia';
import { Db, ObjectId, OptionalId } from 'mongodb';

import type { Env } from '../config.js';
import type { StudySession, User } from '../types.js';
import { isLoginSessionActive, normalizeDeviceId } from '../utils/login-sessions.js';

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

    const authDeviceId = normalizeDeviceId(String(query.deviceId ?? query.device_id ?? headers['x-device-id'] ?? ''));
    const isActive = await isLoginSessionActive(db, new ObjectId(payload.sub), authDeviceId);

    if (!isActive) {
      return status(401, { error: 'Session has been revoked.', code: 'SESSION_REVOKED' });
    }

    return { authUserId: payload.sub, authDeviceId };
  });
}

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

export const leaderboardRoutes = new Elysia<'/leaderboard', AppSingleton>({ prefix: '/leaderboard' })
  .use(requireAuth())
  .get('/daily', async ({ db, authUserId }) => {
    return buildLeaderboard(db, authUserId, getKstDayRange());
  })
  .get('/weekly', async ({ db, authUserId }) => {
    return buildLeaderboard(db, authUserId, getKstWeekRange());
  });

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

  const rankedTotals = Array.from(totals.values())
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, 100);
  const users = await db
    .collection<OptionalId<User>>('users')
    .find({ _id: { $in: rankedTotals.map((item) => item.userId) } })
    .toArray();
  const userMap = new Map(users.map((user) => [user._id.toString(), user]));

  const items = rankedTotals.map((row, index) => {
    const user = userMap.get(row.userId.toString());
    return {
      rank: index + 1,
      userId: row.userId.toString(),
      name: user?.name ?? 'Unknown',
      avatarUrl: user?.avatarUrl,
      totalSeconds: row.totalSeconds,
    };
  });

  const myIndex = items.findIndex((item) => item.userId === authUserId);

  return {
    range,
    items,
    me: myIndex >= 0 ? items[myIndex] : null,
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
