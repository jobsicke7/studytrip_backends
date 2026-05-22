import type { Db } from 'mongodb';

import type { Env } from './config.js';

declare module 'elysia' {
  interface Context {
    env: Env;
    db: Db;
  }
}
