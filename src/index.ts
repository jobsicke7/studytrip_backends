import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { jwt } from '@elysiajs/jwt';
import { config as loadEnv } from 'dotenv';
import dns from 'node:dns';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getEnv } from './config.js';
import { initDb } from './db.js';
import { authRoutes } from './routes/auth.js';
import { appConfigRoutes } from './routes/app-config.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { sessionRoutes } from './routes/sessions.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(currentDir, '..', '.env') });

dns.setServers(['1.1.1.1', '1.0.0.1']);

const env = getEnv();
const db = await initDb(env);

const app = new Elysia()
  .use((app) => {
    app.onRequest((context: any) => {
      context._startTime = Date.now();
    });

    app.onAfterResponse((context: any) => {
      const start = context._startTime ?? Date.now();
      const duration = Date.now() - start;
      const dt = new Date();
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const d = String(dt.getDate()).padStart(2, '0');
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      const ss = String(dt.getSeconds()).padStart(2, '0');
      const date = `${y}.${m}.${d} ${hh}:${mm}:${ss}`; // yyyy.mm.dd hh:mm:ss
      const method = context.request?.method ?? 'UNKNOWN';
      const path = context.path ?? '/';
      const status = context.set?.status ?? 200;

      // ANSI colors: magenta(date), cyan(method), green(path), bright yellow(duration)
      const RESET = '\x1b[0m';
      const MAGENTA = '\x1b[35m';
      const CYAN = '\x1b[36m';
      const GREEN = '\x1b[32m';
      const BRIGHT_YELLOW = '\x1b[93m';

      console.log(`${MAGENTA}${date}${RESET} ${CYAN}${method}${RESET} ${GREEN}${path}${RESET} ${status} - ${BRIGHT_YELLOW}${duration}ms${RESET}`);
    });

    return app;
  })
  .decorate('env', env)
  .decorate('db', db)
  .use(cors())
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET }))
  .get('/health', () => ({ status: 'ok' }))
  .use(appConfigRoutes)
  .use(authRoutes)
  .use(dashboardRoutes)
  .use(sessionRoutes)
  .use(leaderboardRoutes)
  .listen(env.PORT);

console.log(`timer_be listening on http://localhost:${env.PORT}`);
