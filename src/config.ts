export type Env = {
  PORT: number;
  MONGODB_URI: string;
  MONGODB_DB: string;
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_IDS: string[];
  SCHOOL_LAT: number;
  SCHOOL_LNG: number;
  SCHOOL_RADIUS_M: number;
  R2_PUBLIC_BASE_URL: string;
  WHITE_NOISE_KEY_PREFIX: string;
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
  const SCHOOL_LAT = Number(process.env.SCHOOL_LAT ?? 0);
  const SCHOOL_LNG = Number(process.env.SCHOOL_LNG ?? 0);
  const SCHOOL_RADIUS_M = Number(process.env.SCHOOL_RADIUS_M ?? 250);
  const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL ?? '';
  const WHITE_NOISE_KEY_PREFIX = process.env.WHITE_NOISE_KEY_PREFIX ?? 'white-noise';
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
    SCHOOL_LAT,
    SCHOOL_LNG,
    SCHOOL_RADIUS_M,
    R2_PUBLIC_BASE_URL,
    WHITE_NOISE_KEY_PREFIX,
    NODE_ENV,
    isProd: NODE_ENV === 'production',
  };
}
