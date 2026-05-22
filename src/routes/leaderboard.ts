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
  const pipeline = [
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
        stoppedAtResolved: { $gte: range.start, $lt: range.end },
        durationSeconds: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: '$userId',
        totalSeconds: { $sum: '$durationSeconds' },
      },
    },
    { $sort: { totalSeconds: -1 } },
    { $limit: 100 },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: '$user' },
    {
      $project: {
        userId: '$_id',
        totalSeconds: 1,
        name: '$user.name',
        avatarUrl: '$user.avatarUrl',
      },
    },
  ];

  const results = await sessions.aggregate(pipeline).toArray();
  const items = results.map((row, index) => ({
    rank: index + 1,
    userId: row.userId instanceof ObjectId ? row.userId.toString() : String(row.userId),
    name: row.name as User['name'],
    avatarUrl: row.avatarUrl as User['avatarUrl'],
    totalSeconds: row.totalSeconds as number,
  }));

  const myIndex = items.findIndex((item) => item.userId === authUserId);

  return {
    range,
    items,
    me: myIndex >= 0 ? items[myIndex] : null,
  };
}
