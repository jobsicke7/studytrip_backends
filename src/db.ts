import { MongoClient, type Db } from 'mongodb';

import type { Env } from './config.js';

let cachedDb: Db | null = null;

export async function initDb(env: Env): Promise<Db> {
  if (cachedDb) {
    return cachedDb;
  }

  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  cachedDb = client.db(env.MONGODB_DB);

  return cachedDb;
}
