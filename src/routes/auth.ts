import { OAuth2Client } from 'google-auth-library';
import { Elysia, t } from 'elysia';
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Db, ObjectId, OptionalId } from 'mongodb';
import { Resend } from 'resend';

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
const scrypt = promisify(scryptCallback);
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 15 * 60 * 1000;
const emailPurposeSchema = t.Union([t.Literal('signup'), t.Literal('reset')]);

const devUserProfile = {
  email: 'dev@timer.local',
  name: 'Dev User',
  avatarUrl: 'https://api.dicebear.com/9.x/identicon/svg?seed=timer',
};

type KakaoTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type KakaoUserResponse = {
  id?: number;
  properties?: {
    nickname?: string;
    profile_image?: string;
    thumbnail_image?: string;
  };
  kakao_account?: {
    email?: string;
    profile?: {
      nickname?: string;
      profile_image_url?: string;
      thumbnail_image_url?: string;
    };
  };
};

type EmailVerificationCode = {
  _id: ObjectId;
  email: string;
  purpose: 'signup' | 'reset';
  codeHash: string;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
};

type EmailVerificationToken = {
  _id: ObjectId;
  email: string;
  purpose: 'signup' | 'reset';
  tokenHash: string;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getProviderLabel(provider: User['provider']) {
  if (provider === 'google') return 'Google';
  if (provider === 'kakao') return '카카오';
  if (provider === 'email') return '이메일';
  return '테스트';
}

function getDuplicateAccountMessage(provider: User['provider']) {
  return `${getProviderLabel(provider)}로 가입된 계정이예요. 다른 수단으로 로그인 해보세요`;
}

function getUserRole(user: Pick<User, 'role'> | Partial<Pick<User, 'role'>>) {
  return user.role === 'admin' ? 'admin' : 'user';
}

function hashValue(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password: string, passwordHash: string) {
  const [, salt, storedKey] = passwordHash.split(':');
  if (!salt || !storedKey) return false;
  const key = (await scrypt(password, salt, 64)) as Buffer;
  const stored = Buffer.from(storedKey, 'hex');
  return key.length === stored.length && timingSafeEqual(key, stored);
}

async function sendVerificationEmail(env: Env, email: string, code: string, purpose: 'signup' | 'reset') {
  if (!env.RESEND_API_KEY) {
    if (!env.isProd) {
      console.log(`[email-code:${purpose}] ${email} ${code}`);
      return;
    }
    throw new Error('RESEND_API_KEY is not configured.');
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const subject = purpose === 'signup' ? '스터디트립 회원가입 인증코드' : '스터디트립 비밀번호 재설정 인증코드';
  const title = purpose === 'signup' ? '회원가입 인증코드' : '비밀번호 재설정 인증코드';
  const description =
    purpose === 'signup'
      ? '스터디트립 가입을 완료하려면 아래 인증코드를 입력해 주세요.'
      : '비밀번호를 다시 설정하려면 아래 인증코드를 입력해 주세요.';
  const escapedEmail = escapeHtml(email);
  const escapedLogoUrl = escapeHtml(env.RESEND_LOGO_URL);
  const logo = escapedLogoUrl
    ? `<img src="${escapedLogoUrl}" width="56" height="56" alt="스터디트립" style="display:block;border-radius:14px;object-fit:cover;" />`
    : '<div style="width:56px;height:56px;border-radius:14px;background:#6410EA;color:#ffffff;font-size:18px;font-weight:900;line-height:56px;text-align:center;">ST</div>';
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: email,
    subject,
    html: `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f3ff;font-family:Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#181124;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f3ff;padding:36px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(52,18,112,0.16);">
            <tr>
              <td style="padding:34px 34px 20px;">
                <div style="margin-top:22px;font-size:14px;line-height:20px;font-weight:800;color:#6410EA;">스터디트립</div>
                <h1 style="margin:8px 0 0;font-size:26px;line-height:34px;font-weight:900;color:#181124;">${title}</h1>
                <p style="margin:12px 0 0;font-size:15px;line-height:24px;color:#5d536f;">${description}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 34px 24px;">
                <div style="border-radius:18px;background:#f3ecff;border:1px solid #ded0ff;padding:24px;text-align:center;">
                  <div style="font-size:12px;line-height:18px;font-weight:800;color:#79679a;">인증코드</div>
                  <div style="margin-top:8px;font-size:38px;line-height:46px;font-weight:900;letter-spacing:8px;color:#4B00BF;">${code}</div>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 34px 34px;">
                <p style="margin:0;font-size:13px;line-height:21px;color:#7a7188;">이 코드는 10분 동안 사용할 수 있어요</p>
                <p style="margin:14px 0 0;font-size:12px;line-height:19px;color:#9a90aa;">본인이 요청하지 않았다면 이 메일을 무시해 주세요</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    text: `인증코드는 ${code} 입니다. 10분 안에 입력해 주세요.`,
  });

  if (error) {
    throw new Error(error.message);
  }
}

async function consumeVerificationToken(db: Db, email: string, purpose: 'signup' | 'reset', token: string) {
  const tokens = db.collection<OptionalId<EmailVerificationToken>>('emailVerificationTokens');
  const now = new Date();
  const tokenHash = hashValue(token);
  const verification = await tokens.findOne({ email, purpose, tokenHash, consumedAt: { $exists: false }, expiresAt: { $gt: now } });
  if (!verification) return false;
  await tokens.updateOne({ _id: verification._id }, { $set: { consumedAt: now } });
  return true;
}

export const authRoutes = new Elysia<'/auth', AppSingleton>({ prefix: '/auth' })
  .get('/kakao/redirect', ({ query, env, set }) => {
    const target = new URL(`${env.KAKAO_NATIVE_REDIRECT_SCHEME}://oauthredirect`);
    const code = typeof query.code === 'string' ? query.code : null;
    const error = typeof query.error === 'string' ? query.error : null;
    const errorDescription = typeof query.error_description === 'string' ? query.error_description : null;
    const state = typeof query.state === 'string' ? query.state : null;

    if (code) {
      target.searchParams.set('code', code);
    }
    if (error) {
      target.searchParams.set('error', error);
    }
    if (errorDescription) {
      target.searchParams.set('error_description', errorDescription);
    }
    if (state) {
      target.searchParams.set('state', state);
    }

    return Response.redirect(target.toString(), 302);
  }, {
    detail: { summary: 'Kakao native login redirect bridge' },
  })
  .post(
    '/email-code/request',
    async ({ body, db, env, set }) => {
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) {
        set.status = 400;
        return { error: '올바른 이메일을 입력해 주세요.' };
      }

      const users = db.collection<OptionalId<User>>('users');
      const existing = await users.findOne({ email });
      if (body.purpose === 'signup' && existing) {
        set.status = 409;
        return { error: getDuplicateAccountMessage(existing.provider) };
      }
      if (body.purpose === 'reset' && (!existing || !existing.passwordHash)) {
        set.status = 404;
        return { error: '이메일 계정을 찾을 수 없어요' };
      }

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const now = new Date();
      await db.collection<OptionalId<EmailVerificationCode>>('emailVerificationCodes').insertOne({
        email,
        purpose: body.purpose,
        codeHash: hashValue(code),
        expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
        createdAt: now,
      });

      await sendVerificationEmail(env, email, code, body.purpose);
      return { ok: true };
    },
    {
      body: t.Object({
        email: t.String({ minLength: 3 }),
        purpose: emailPurposeSchema,
      }),
      detail: { summary: 'Request email verification code' },
    }
  )
  .post(
    '/email-code/verify',
    async ({ body, db, set }) => {
      const email = normalizeEmail(body.email);
      const now = new Date();
      const codes = db.collection<OptionalId<EmailVerificationCode>>('emailVerificationCodes');
      const verification = await codes.findOne({
        email,
        purpose: body.purpose,
        codeHash: hashValue(body.code),
        consumedAt: { $exists: false },
        expiresAt: { $gt: now },
      });

      if (!verification) {
        set.status = 401;
        return { error: '인증코드가 일치하지 않아요' };
      }

      await codes.updateOne({ _id: verification._id }, { $set: { consumedAt: now } });
      const verificationToken = randomBytes(32).toString('hex');
      await db.collection<OptionalId<EmailVerificationToken>>('emailVerificationTokens').insertOne({
        email,
        purpose: body.purpose,
        tokenHash: hashValue(verificationToken),
        expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
        createdAt: now,
      });

      return { verificationToken };
    },
    {
      body: t.Object({
        email: t.String({ minLength: 3 }),
        purpose: emailPurposeSchema,
        code: t.String({ minLength: 6, maxLength: 6 }),
      }),
      detail: { summary: 'Verify email code' },
    }
  )
  .post(
    '/signup',
    async ({ body, db, set }) => {
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) {
        set.status = 400;
        return { error: '올바른 이메일을 입력해 주세요.' };
      }
      if (body.password.length < 8) {
        set.status = 400;
        return { error: '비밀번호는 8자 이상이어야 합니다.' };
      }
      if (!(await consumeVerificationToken(db, email, 'signup', body.verificationToken))) {
        set.status = 401;
        return { error: '이메일 인증을 다시 진행해 주세요.' };
      }

      const users = db.collection<OptionalId<User>>('users');
      const existing = await users.findOne({ email });
      if (existing) {
        set.status = 409;
        return { error: getDuplicateAccountMessage(existing.provider) };
      }

      const now = new Date();
      await users.insertOne({
        email,
        providerAccountId: email,
        name: email.split('@')[0],
        provider: 'email',
        role: 'user',
        passwordHash: await hashPassword(body.password),
        createdAt: now,
        updatedAt: now,
      });

      return { ok: true };
    },
    {
      body: t.Object({
        email: t.String({ minLength: 3 }),
        password: t.String({ minLength: 8 }),
        verificationToken: t.String({ minLength: 16 }),
      }),
      detail: { summary: 'Email signup' },
    }
  )
  .post(
    '/password-reset',
    async ({ body, db, set }) => {
      const email = normalizeEmail(body.email);
      if (body.password.length < 8) {
        set.status = 400;
        return { error: '비밀번호는 8자 이상이어야 합니다.' };
      }
      if (!(await consumeVerificationToken(db, email, 'reset', body.verificationToken))) {
        set.status = 401;
        return { error: '이메일 인증을 다시 진행해 주세요.' };
      }

      const result = await db.collection<OptionalId<User>>('users').updateOne(
        { email, provider: 'email' },
        {
          $set: {
            passwordHash: await hashPassword(body.password),
            updatedAt: new Date(),
          },
        }
      );
      if (result.matchedCount === 0) {
        set.status = 404;
        return { error: '이메일 계정을 찾을 수 없어요' };
      }

      return { ok: true };
    },
    {
      body: t.Object({
        email: t.String({ minLength: 3 }),
        password: t.String({ minLength: 8 }),
        verificationToken: t.String({ minLength: 16 }),
      }),
      detail: { summary: 'Reset email password' },
    }
  )
  .post(
    '/email-login',
    async ({ body, query, headers, request, server, db, jwt, set }) => {
      const email = normalizeEmail(body.email);
      const users = db.collection<OptionalId<User>>('users');
      const user = await users.findOne({ email, provider: 'email' });
      if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
        set.status = 401;
        return { error: '이메일 또는 비밀번호가 올바르지 않아요' };
      }

      const token = await jwt.sign({
        sub: user._id.toString(),
        email: user.email,
        provider: user.provider,
        isDeveloper: false,
        role: getUserRole(user),
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
          isDeveloper: false,
          role: getUserRole(user),
        },
      };
    },
    {
      body: t.Object({
        email: t.String({ minLength: 3 }),
        password: t.String({ minLength: 1 }),
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
      detail: { summary: 'Email login' },
    }
  )
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
          providerAccountId: 'dev',
          provider: 'dev',
          role: 'user',
          createdAt: now,
          updatedAt: now,
        });
        user = {
          _id: result.insertedId,
          ...devUserProfile,
          provider: 'dev',
          role: 'user',
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
        role: getUserRole(user),
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
          role: getUserRole(user),
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
    '/kakao',
    async ({ body, query, headers, request, server, db, env, jwt, set }) => {
      if (!env.KAKAO_REST_API_KEY) {
        set.status = 500;
        return { error: 'KAKAO_REST_API_KEY is not configured.' };
      }

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.KAKAO_REST_API_KEY,
        redirect_uri: body.redirectUri,
        code: body.code,
      });
      if (env.KAKAO_CLIENT_SECRET) {
        tokenParams.set('client_secret', env.KAKAO_CLIENT_SECRET);
      }

      const tokenResponse = await fetch('https://kauth.kakao.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
        body: tokenParams,
      });
      const tokenPayload = await tokenResponse.json() as KakaoTokenResponse;

      if (!tokenResponse.ok || !tokenPayload.access_token) {
        set.status = 401;
        return { error: tokenPayload.error_description ?? tokenPayload.error ?? 'Invalid Kakao authorization code.' };
      }

      const userResponse = await fetch('https://kapi.kakao.com/v2/user/me', {
        headers: {
          Authorization: `Bearer ${tokenPayload.access_token}`,
        },
      });
      const kakaoUser = await userResponse.json() as KakaoUserResponse;

      if (!userResponse.ok || !kakaoUser.id) {
        set.status = 401;
        return { error: 'Failed to retrieve Kakao user information.' };
      }

      const kakaoId = String(kakaoUser.id);
      const email = kakaoUser.kakao_account?.email ?? `kakao-${kakaoId}@kakao.local`;
      const providerAccountId = `kakao:${kakaoId}`;
      const name =
        kakaoUser.kakao_account?.profile?.nickname ??
        kakaoUser.properties?.nickname ??
        email.split('@')[0];
      const avatarUrl =
        kakaoUser.kakao_account?.profile?.profile_image_url ??
        kakaoUser.properties?.profile_image ??
        kakaoUser.kakao_account?.profile?.thumbnail_image_url ??
        kakaoUser.properties?.thumbnail_image;

      const now = new Date();
      const users = db.collection<OptionalId<User>>('users');
      const existing = await users.findOne({
        $or: [
          { provider: 'kakao', providerAccountId },
          { provider: 'kakao', email },
        ],
      });
      if (!existing && kakaoUser.kakao_account?.email) {
        const conflictingAccount = await users.findOne({ email });
        if (conflictingAccount) {
          set.status = 409;
          return { error: getDuplicateAccountMessage(conflictingAccount.provider) };
        }
      }

      let user = existing;
      if (!user) {
        const result = await users.insertOne({
          email,
          providerAccountId,
          name,
          avatarUrl,
          provider: 'kakao',
          role: 'user',
          createdAt: now,
          updatedAt: now,
        });
        user = {
          _id: result.insertedId,
          email,
          name,
          avatarUrl,
          provider: 'kakao',
          role: 'user',
          createdAt: now,
          updatedAt: now,
        };
      } else {
        await users.updateOne(
          { _id: new ObjectId(user._id) },
          {
            $set: {
              providerAccountId,
              name,
              avatarUrl: avatarUrl ?? user.avatarUrl,
              updatedAt: now,
            },
          }
        );
        user = {
          ...user,
          name,
          avatarUrl: avatarUrl ?? user.avatarUrl,
          updatedAt: now,
        };
      }

      const token = await jwt.sign({
        sub: user._id.toString(),
        email: user.email,
        provider: user.provider,
        isDeveloper: user.provider === 'dev',
        role: getUserRole(user),
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
          role: getUserRole(user),
        },
      };
    },
    {
      body: t.Object({
        code: t.String({ minLength: 8 }),
        redirectUri: t.String({ minLength: 8 }),
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
      detail: { summary: 'Kakao login' },
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

      const email = normalizeEmail(payload.email);
      const providerAccountId = `google:${payload.sub}`;
      const now = new Date();
      const users = db.collection<OptionalId<User>>('users');
      const existing = await users.findOne({
        $or: [
          { provider: 'google', providerAccountId },
          { email },
        ],
      });

      if (existing && existing.provider !== 'google') {
        set.status = 409;
        return { error: getDuplicateAccountMessage(existing.provider) };
      }

      let user = existing;
      if (!user) {
        const result = await users.insertOne({
          email,
          providerAccountId,
          name: payload.name ?? email.split('@')[0],
          avatarUrl: payload.picture,
          provider: 'google',
          role: 'user',
          createdAt: now,
          updatedAt: now,
        });
        user = {
          _id: result.insertedId,
          email,
          name: payload.name ?? email.split('@')[0],
          avatarUrl: payload.picture,
          provider: 'google',
          role: 'user',
          createdAt: now,
          updatedAt: now,
        };
      } else if (payload.name || payload.picture) {
        await users.updateOne(
          { _id: new ObjectId(user._id) },
          {
            $set: {
              providerAccountId,
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
        role: getUserRole(user),
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
          role: getUserRole(user),
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
