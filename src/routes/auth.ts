import { OAuth2Client } from 'google-auth-library';
import { Elysia, t } from 'elysia';
import { Db, ObjectId, OptionalId } from 'mongodb';

import type { Env } from '../config.js';
import type { User } from '../types.js';
import { buildLoginSessionMetadata, recordLoginSession } from '../utils/login-sessions.js';

type JwtService = {
  sign: (payload: Record<string, unknown>) => Promise<string>;
};

type AppSingleton = {
  decorator: {
    db: Db;
    env: Env;
    jwt: JwtService;
  };
  store: {};
  derive: {};
  resolve: {};
};

const optionalString = t.Optional(t.Union([t.String(), t.Null()]));
const optionalNumber = t.Optional(t.Union([t.Number(), t.Null()]));

const devUserProfile = {
  email: 'dev@timer.local',
  name: 'Dev User',
  avatarUrl: 'https://api.dicebear.com/9.x/identicon/svg?seed=timer',
};

export const authRoutes = new Elysia<'/auth', AppSingleton>({ prefix: '/auth' })
  .post(
    '/dev-login',
    async ({ body, query, headers, request, server, db, env, jwt, set }) => {
      if (env.isProd) {
        set.status = 403;
        return { error: 'Dev login is disabled in production.' };
      }

      const now = new Date();
      const users = db.collection<OptionalId<User>>('users');
      const existing = await users.findOne({ email: devUserProfile.email });

      let user = existing;
      if (!user) {
        const result = await users.insertOne({
          ...devUserProfile,
          provider: 'dev',
          createdAt: now,
          updatedAt: now,
        });
        user = {
          _id: result.insertedId,
          ...devUserProfile,
          provider: 'dev',
          createdAt: now,
          updatedAt: now,
        };
      } else if (user.avatarUrl !== devUserProfile.avatarUrl) {
        await users.updateOne(
          { _id: new ObjectId(user._id) },
          {
            $set: {
              avatarUrl: devUserProfile.avatarUrl,
              updatedAt: now,
            },
          }
        );
        user = {
          ...user,
          avatarUrl: devUserProfile.avatarUrl,
          updatedAt: now,
        };
      }

      const token = await jwt.sign({
        sub: user._id.toString(),
        email: user.email,
        provider: user.provider,
        isDeveloper: user.provider === 'dev',
      });

      await recordLoginSession(
        db,
        new ObjectId(user._id),
        buildLoginSessionMetadata({ body: body as Record<string, unknown> | undefined, query, headers, request, server })
      );

      return {
        token,
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          provider: user.provider,
          isDeveloper: user.provider === 'dev',
        },
      };
    },
    {
      body: t.Optional(
        t.Object({
          deviceId: optionalString,
          device_id: optionalString,
          deviceName: optionalString,
          device_name: optionalString,
          deviceType: optionalString,
          device_type: optionalString,
          platform: optionalString,
          userAgent: optionalString,
          user_agent: optionalString,
          browserName: optionalString,
          browser_name: optionalString,
          browserVersion: optionalString,
          browser_version: optionalString,
          osName: optionalString,
          os_name: optionalString,
          osVersion: optionalString,
          os_version: optionalString,
          ipAddress: optionalString,
          ip_address: optionalString,
          regionName: optionalString,
          region_name: optionalString,
          cityName: optionalString,
          city_name: optionalString,
          districtName: optionalString,
          district_name: optionalString,
          countryName: optionalString,
          country_name: optionalString,
          latitude: optionalNumber,
          longitude: optionalNumber,
        })
      ),
      detail: { summary: 'Dev login' },
    }
  )
  .post(
    '/google',
    async ({ body, query, headers, request, server, db, env, jwt, set }) => {
      if (env.GOOGLE_CLIENT_IDS.length === 0) {
        set.status = 500;
        return { error: 'GOOGLE_CLIENT_ID is not configured.' };
      }

      const client = new OAuth2Client();
      const ticket = await client.verifyIdToken({
        idToken: body.idToken,
        audience: env.GOOGLE_CLIENT_IDS,
      });
      const payload = ticket.getPayload();

      if (!payload || !payload.email || !payload.sub) {
        set.status = 401;
        return { error: 'Invalid Google token.' };
      }

      const now = new Date();
      const users = db.collection<OptionalId<User>>('users');
      const existing = await users.findOne({ email: payload.email });

      let user = existing;
      if (!user) {
        const result = await users.insertOne({
          email: payload.email,
          name: payload.name ?? payload.email.split('@')[0],
          avatarUrl: payload.picture,
          provider: 'google',
          createdAt: now,
          updatedAt: now,
        });
        user = {
          _id: result.insertedId,
          email: payload.email,
          name: payload.name ?? payload.email.split('@')[0],
          avatarUrl: payload.picture,
          provider: 'google',
          createdAt: now,
          updatedAt: now,
        };
      } else if (payload.name || payload.picture) {
        await users.updateOne(
          { _id: new ObjectId(user._id) },
          {
            $set: {
              name: payload.name ?? user.name,
              avatarUrl: payload.picture ?? user.avatarUrl,
              updatedAt: now,
            },
          }
        );
        user = {
          ...user,
          name: payload.name ?? user.name,
          avatarUrl: payload.picture ?? user.avatarUrl,
          updatedAt: now,
        };
      }

      const token = await jwt.sign({
        sub: user._id.toString(),
        email: user.email,
        provider: user.provider,
        isDeveloper: user.provider === 'dev',
      });

      await recordLoginSession(
        db,
        new ObjectId(user._id),
        buildLoginSessionMetadata({ body: body as Record<string, unknown>, query, headers, request, server })
      );

      return {
        token,
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          provider: user.provider,
          isDeveloper: user.provider === 'dev',
        },
      };
    },
    {
      body: t.Object({
        idToken: t.String({ minLength: 16 }),
        deviceId: optionalString,
        device_id: optionalString,
        deviceName: optionalString,
        device_name: optionalString,
        deviceType: optionalString,
        device_type: optionalString,
        platform: optionalString,
        userAgent: optionalString,
        user_agent: optionalString,
        browserName: optionalString,
        browser_name: optionalString,
        browserVersion: optionalString,
        browser_version: optionalString,
        osName: optionalString,
        os_name: optionalString,
        osVersion: optionalString,
        os_version: optionalString,
        ipAddress: optionalString,
        ip_address: optionalString,
        regionName: optionalString,
        region_name: optionalString,
        cityName: optionalString,
        city_name: optionalString,
        districtName: optionalString,
        district_name: optionalString,
        countryName: optionalString,
        country_name: optionalString,
        latitude: optionalNumber,
        longitude: optionalNumber,
      }),
      detail: { summary: 'Google login' },
    }
  );
