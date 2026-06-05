import { MongoClient, ObjectId, type Db } from 'mongodb';

import type { Env } from './config.js';

let cachedDb: Db | null = null;

export async function initDb(env: Env): Promise<Db> {
  if (cachedDb) {
    return cachedDb;
  }

  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  cachedDb = client.db(env.MONGODB_DB);
  await cachedDb.collection('users').updateMany({ role: { $exists: false } }, { $set: { role: 'user' } });
  await cleanupDuplicateSubjects(cachedDb);
  await cachedDb.collection('subjects').createIndex({ userId: 1, subjectId: 1 }, { unique: true });

  return cachedDb;
}

async function cleanupDuplicateSubjects(db: Db) {
  const subjects = db.collection('subjects');
  const duplicateGroups = await subjects
    .aggregate<{ ids: ObjectId[] }>([
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: { userId: '$userId', subjectId: '$subjectId' },
          ids: { $push: '$_id' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  await Promise.all(
    duplicateGroups.map((group) =>
      subjects.deleteMany({
        _id: { $in: group.ids.slice(1) },
      })
    )
  );
}
