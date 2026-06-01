export type Env = {
  PORT: number;
  MONGODB_URI: string;
  MONGODB_DB: string;
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_IDS: string[];
  KAKAO_REST_API_KEY: string;
  KAKAO_CLIENT_SECRET: string;
  KAKAO_NATIVE_REDIRECT_SCHEME: string;
  SCHOOL_LAT: number;
  SCHOOL_LNG: number;
  SCHOOL_RADIUS_M: number;
  R2_PUBLIC_BASE_URL: string;
  WHITE_NOISE_KEY_PREFIX: string;
  BACKGROUND_KEY_PREFIX: string;
  FONT_KEY_PREFIX: string;
  SHOW_TEST_LOGIN_BUTTON: boolean;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  RESEND_LOGO_URL: string;
  NODE_ENV: string;
  isProd: boolean;
};

export function getEnv(): Env {
  const PORT = Number(process.env.PORT ?? 4000);
  const MONGODB_URI = process.env.MONGODB_URI ?? '';
  const MONGODB_DB = process.env.MONGODB_DB ?? 'timer';
  const JWT_SECRET = process.env.JWT_SECRET ?? '';
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
  const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_IDS ?? GOOGLE_CLIENT_ID)
    .split(',')
    .map((clientId) => clientId.trim())
    .filter(Boolean);
  const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY ?? '';
  const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET ?? '';
  const KAKAO_NATIVE_REDIRECT_SCHEME = process.env.KAKAO_NATIVE_REDIRECT_SCHEME ?? 'timer';
  const SCHOOL_LAT = Number(process.env.SCHOOL_LAT ?? 37.56249619);
  const SCHOOL_LNG = Number(process.env.SCHOOL_LNG ?? 127.0894052);
  const SCHOOL_RADIUS_M = Number(process.env.SCHOOL_RADIUS_M ?? 250);
  const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL ?? '';
  const WHITE_NOISE_KEY_PREFIX = process.env.WHITE_NOISE_KEY_PREFIX ?? 'white-noise';
  const BACKGROUND_KEY_PREFIX = process.env.BACKGROUND_KEY_PREFIX ?? 'background';
  const FONT_KEY_PREFIX = process.env.FONT_KEY_PREFIX ?? 'fonts';
  const SHOW_TEST_LOGIN_BUTTON = (process.env.SHOW_TEST_LOGIN_BUTTON ?? 'true').toLowerCase() === 'true';
  const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? '스터디트립 <onboarding@resend.dev>';
  const RESEND_LOGO_URL = process.env.RESEND_LOGO_URL ?? '';
  const NODE_ENV = process.env.NODE_ENV ?? 'development';

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is required');
  }

  return {
    PORT,
    MONGODB_URI,
    MONGODB_DB,
    JWT_SECRET,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_IDS,
    KAKAO_REST_API_KEY,
    KAKAO_CLIENT_SECRET,
    KAKAO_NATIVE_REDIRECT_SCHEME,
    SCHOOL_LAT,
    SCHOOL_LNG,
    SCHOOL_RADIUS_M,
    R2_PUBLIC_BASE_URL,
    WHITE_NOISE_KEY_PREFIX,
    BACKGROUND_KEY_PREFIX,
    FONT_KEY_PREFIX,
    SHOW_TEST_LOGIN_BUTTON,
    RESEND_API_KEY,
    RESEND_FROM_EMAIL,
    RESEND_LOGO_URL,
    NODE_ENV,
    isProd: NODE_ENV === 'production',
  };
}
