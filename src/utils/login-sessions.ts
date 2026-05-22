import { Db, ObjectId, OptionalId } from 'mongodb';

import type { LoginSession } from '../types.js';

export type LoginSessionMetadata = {
  deviceId?: string;
  deviceName?: string;
  deviceType?: string;
  platform?: string;
  userAgent?: string;
  browserName?: string | null;
  browserVersion?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  ipAddress?: string | null;
  regionName?: string | null;
  cityName?: string | null;
  districtName?: string | null;
  countryName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

type HeaderMap = Record<string, string | undefined>;
type RequestIpSource = {
  request?: Request;
  server?: {
    requestIP?: (request: Request) => { address?: string; port?: number; family?: string } | null;
  } | null;
};

const DEVICE_ID_MAX_LENGTH = 80;

export function getHeaderValue(headers: HeaderMap, key: string) {
  return headers[key] ?? headers[key.toLowerCase()];
}

export function normalizeDeviceId(value?: string | null) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return 'default';
  return trimmed.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, DEVICE_ID_MAX_LENGTH) || 'default';
}

function normalizeIpAddress(value?: string | null) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const withoutPrefix = raw.replace(/^::ffff:/, '');
  return withoutPrefix === '::1' ? '127.0.0.1' : withoutPrefix;
}

function normalizeCoordinate(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isPrivateIp(ip?: string | null) {
  if (!ip) return false;
  return (
    ip === '127.0.0.1' ||
    ip === 'localhost' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    /^fe80:/i.test(ip) ||
    /^fc/i.test(ip) ||
    /^fd/i.test(ip)
  );
}

export function getClientIp(headers: HeaderMap, source?: RequestIpSource) {
  const forwarded = getHeaderValue(headers, 'x-forwarded-for');
  if (forwarded) {
    return normalizeIpAddress(forwarded.split(',')[0]);
  }

  const headerIp = getHeaderValue(headers, 'x-real-ip') ?? getHeaderValue(headers, 'cf-connecting-ip');
  if (headerIp) {
    return normalizeIpAddress(headerIp);
  }

  if (source?.request && source.server?.requestIP) {
    return normalizeIpAddress(source.server.requestIP(source.request)?.address);
  }

  return null;
}

export function getRegionName(headers: HeaderMap, ipAddress?: string | null) {
  const fromHeaders =
    getHeaderValue(headers, 'x-vercel-ip-city') ??
    getHeaderValue(headers, 'x-vercel-ip-country-region') ??
    getHeaderValue(headers, 'cf-ipcountry') ??
    null;

  if (fromHeaders) return decodeURIComponent(fromHeaders);
  if (ipAddress === '127.0.0.1') return '로컬호스트';
  if (isPrivateIp(ipAddress)) return '로컬 네트워크';

  return (
    null
  );
}

export function inferDeviceType(platform: string, userAgent: string) {
  if (platform === 'web') return 'web';
  if (/ipad|tablet|tab|sm-x/i.test(`${platform} ${userAgent}`)) return 'tablet';
  if (/mobile|android|iphone|ipad|expo/i.test(`${platform} ${userAgent}`)) return 'smartphone';
  return 'web';
}

export function inferDeviceName(platform: string, userAgent: string) {
  if (/Expo/i.test(userAgent)) return 'Expo Go';
  if (/iPhone/i.test(userAgent)) return 'iPhone';
  if (/iPad/i.test(userAgent)) return 'iPad';
  if (/Android/i.test(userAgent)) return 'Android 기기';
  if (/Edg\//i.test(userAgent)) return 'Microsoft Edge';
  if (/Chrome\//i.test(userAgent)) return 'Chrome';
  if (/Firefox\//i.test(userAgent)) return 'Firefox';
  if (/Safari\//i.test(userAgent)) return 'Safari';
  if (platform && platform !== 'unknown') return `${platform} 기기`;
  return '알 수 없는 기기';
}

function getUaMatch(userAgent: string, pattern: RegExp) {
  const match = userAgent.match(pattern);
  return match?.[1]?.replace(/_/g, '.') ?? null;
}

export function inferBrowserName(userAgent: string) {
  if (/Edg\//i.test(userAgent)) return 'Microsoft Edge';
  if (/Chrome\//i.test(userAgent) && !/Edg\//i.test(userAgent)) return 'Chrome';
  if (/Firefox\//i.test(userAgent)) return 'Firefox';
  if (/Safari\//i.test(userAgent) && !/Chrome\//i.test(userAgent)) return 'Safari';
  return null;
}

export function inferBrowserVersion(userAgent: string) {
  return (
    getUaMatch(userAgent, /Edg\/([\d.]+)/i) ??
    getUaMatch(userAgent, /Chrome\/([\d.]+)/i) ??
    getUaMatch(userAgent, /Firefox\/([\d.]+)/i) ??
    getUaMatch(userAgent, /Version\/([\d.]+).*Safari/i)
  );
}

export function inferOsName(platform: string, userAgent: string) {
  if (/Windows NT/i.test(userAgent)) return 'Windows';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iOS';
  if (/Mac OS X/i.test(userAgent)) return 'macOS';
  if (/Linux/i.test(userAgent)) return 'Linux';
  if (platform && platform !== 'unknown') return platform;
  return null;
}

export function inferOsVersion(userAgent: string) {
  return (
    getUaMatch(userAgent, /Windows NT ([\d.]+)/i) ??
    getUaMatch(userAgent, /Android ([\d.]+)/i) ??
    getUaMatch(userAgent, /OS ([\d_]+) like Mac OS X/i) ??
    getUaMatch(userAgent, /Mac OS X ([\d_]+)/i)
  );
}

export function buildLoginSessionMetadata({
  body,
  query,
  headers,
  request,
  server,
}: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers: HeaderMap;
  request?: Request;
  server?: RequestIpSource['server'];
}): LoginSessionMetadata {
  const userAgent = String(body?.userAgent ?? body?.user_agent ?? getHeaderValue(headers, 'x-device-user-agent') ?? getHeaderValue(headers, 'user-agent') ?? '');
  const platform = String(body?.platform ?? query?.platform ?? getHeaderValue(headers, 'x-device-platform') ?? 'unknown');
  const deviceId = normalizeDeviceId(
    String(body?.deviceId ?? body?.device_id ?? query?.deviceId ?? query?.device_id ?? getHeaderValue(headers, 'x-device-id') ?? '')
  );
  const deviceName = String(
    body?.deviceName ?? body?.device_name ?? query?.deviceName ?? query?.device_name ?? getHeaderValue(headers, 'x-device-name') ?? ''
  ).trim();
  const deviceType = String(
    body?.deviceType ?? body?.device_type ?? query?.deviceType ?? query?.device_type ?? getHeaderValue(headers, 'x-device-type') ?? ''
  ).trim();
  const browserName = String(body?.browserName ?? body?.browser_name ?? getHeaderValue(headers, 'x-device-browser-name') ?? '').trim();
  const browserVersion = String(
    body?.browserVersion ?? body?.browser_version ?? getHeaderValue(headers, 'x-device-browser-version') ?? ''
  ).trim();
  const osName = String(body?.osName ?? body?.os_name ?? getHeaderValue(headers, 'x-device-os-name') ?? '').trim();
  const osVersion = String(body?.osVersion ?? body?.os_version ?? getHeaderValue(headers, 'x-device-os-version') ?? '').trim();
  const bodyIpAddress = String(body?.ipAddress ?? body?.ip_address ?? '').trim();
  const regionName = String(body?.regionName ?? body?.region_name ?? '').trim();
  const cityName = String(body?.cityName ?? body?.city_name ?? '').trim();
  const districtName = String(body?.districtName ?? body?.district_name ?? '').trim();
  const countryName = String(body?.countryName ?? body?.country_name ?? '').trim();
  const latitude = normalizeCoordinate(body?.latitude);
  const longitude = normalizeCoordinate(body?.longitude);
  const ipAddress = getClientIp(headers, { request, server });

  return {
    deviceId,
    deviceName: deviceName || inferDeviceName(platform, userAgent),
    deviceType: deviceType || inferDeviceType(platform, userAgent),
    platform,
    userAgent,
    browserName: browserName || inferBrowserName(userAgent),
    browserVersion: browserVersion || inferBrowserVersion(userAgent),
    osName: osName || inferOsName(platform, userAgent),
    osVersion: osVersion || inferOsVersion(userAgent),
    ipAddress: bodyIpAddress || null,
    regionName: regionName || null,
    cityName: cityName || null,
    districtName: districtName || null,
    countryName: countryName || null,
    latitude,
    longitude,
  };
}

export async function recordLoginSession(db: Db, userId: ObjectId, metadata: LoginSessionMetadata) {
  const now = new Date();
  const deviceId = normalizeDeviceId(metadata.deviceId);
  const platform = metadata.platform || 'unknown';
  const userAgent = metadata.userAgent || '';

  await db.collection<OptionalId<LoginSession>>('login_sessions').updateOne(
    { userId, deviceId },
    {
      $set: {
        deviceName: metadata.deviceName || inferDeviceName(platform, userAgent),
        deviceType: metadata.deviceType || inferDeviceType(platform, userAgent),
        platform,
        userAgent,
        browserName: metadata.browserName ?? inferBrowserName(userAgent),
        browserVersion: metadata.browserVersion ?? inferBrowserVersion(userAgent),
        osName: metadata.osName ?? inferOsName(platform, userAgent),
        osVersion: metadata.osVersion ?? inferOsVersion(userAgent),
        ipAddress: metadata.ipAddress ?? null,
        regionName: metadata.regionName ?? null,
        cityName: metadata.cityName ?? null,
        districtName: metadata.districtName ?? null,
        countryName: metadata.countryName ?? null,
        latitude: metadata.latitude ?? null,
        longitude: metadata.longitude ?? null,
        isActive: true,
        lastLogin: now,
        lastSeenAt: now,
        revokedAt: null,
        updatedAt: now,
      },
      $setOnInsert: { userId, deviceId, createdAt: now },
    },
    { upsert: true }
  );
}

export async function touchLoginSession(db: Db, userId: ObjectId, metadata: LoginSessionMetadata) {
  const deviceId = normalizeDeviceId(metadata.deviceId);
  if (deviceId === 'default') return;

  const now = new Date();
  const platform = metadata.platform || 'unknown';
  const userAgent = metadata.userAgent || '';

  const setUpdate: Partial<LoginSession> = {
    deviceName: metadata.deviceName || inferDeviceName(platform, userAgent),
    deviceType: metadata.deviceType || inferDeviceType(platform, userAgent),
    platform,
    userAgent,
    browserName: metadata.browserName ?? inferBrowserName(userAgent),
    browserVersion: metadata.browserVersion ?? inferBrowserVersion(userAgent),
    osName: metadata.osName ?? inferOsName(platform, userAgent),
    osVersion: metadata.osVersion ?? inferOsVersion(userAgent),
    isActive: true,
    lastSeenAt: now,
    updatedAt: now,
  };

  if (metadata.ipAddress) setUpdate.ipAddress = metadata.ipAddress;
  if (metadata.regionName) setUpdate.regionName = metadata.regionName;
  if (metadata.cityName) setUpdate.cityName = metadata.cityName;
  if (metadata.districtName) setUpdate.districtName = metadata.districtName;
  if (metadata.countryName) setUpdate.countryName = metadata.countryName;
  if (metadata.latitude !== null && metadata.latitude !== undefined) setUpdate.latitude = metadata.latitude;
  if (metadata.longitude !== null && metadata.longitude !== undefined) setUpdate.longitude = metadata.longitude;

  await db.collection<OptionalId<LoginSession>>('login_sessions').updateOne(
    { userId, deviceId },
    {
      $set: setUpdate,
      $setOnInsert: {
        userId,
        deviceId,
        lastLogin: now,
        createdAt: now,
        revokedAt: null,
      },
    },
    { upsert: true }
  );
}

export function toLoginSessionResponse(session: LoginSession, currentDeviceId: string) {
  const isCurrent = session.deviceId === currentDeviceId;
  const lastLogin = session.lastLogin?.toISOString?.() ?? new Date().toISOString();
  const lastSeenAt = session.lastSeenAt?.toISOString?.() ?? lastLogin;

  return {
    sessionId: session.deviceId,
    deviceName: session.deviceName,
    platform: session.platform,
    isCurrent,
    isActive: session.isActive !== false,
    lastActiveAt: lastSeenAt,
    deviceId: session.deviceId,
    deviceType: session.deviceType,
    browserName: session.browserName ?? null,
    browserVersion: session.browserVersion ?? null,
    osName: session.osName ?? null,
    osVersion: session.osVersion ?? null,
    ipAddress: session.ipAddress ?? null,
    regionName: session.regionName ?? null,
    cityName: session.cityName ?? null,
    districtName: session.districtName ?? null,
    countryName: session.countryName ?? null,
    latitude: session.latitude ?? null,
    longitude: session.longitude ?? null,
    lastLogin,
    lastSeenAt,
    revokedAt: session.revokedAt?.toISOString?.() ?? null,
    device_id: session.deviceId,
    device_name: session.deviceName,
    device_type: session.deviceType,
    browser_name: session.browserName ?? null,
    browser_version: session.browserVersion ?? null,
    os_name: session.osName ?? null,
    os_version: session.osVersion ?? null,
    ip_address: session.ipAddress ?? null,
    city_name: session.cityName ?? null,
    district_name: session.districtName ?? null,
    country_name: session.countryName ?? null,
    is_active: session.isActive !== false,
    last_login: lastLogin,
    last_seen_at: lastSeenAt,
    region_name: session.regionName ?? null,
    revoked_at: session.revokedAt?.toISOString?.() ?? null,
  };
}

export async function isLoginSessionActive(db: Db, userId: ObjectId, deviceId: string) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  if (normalizedDeviceId === 'default') {
    return true;
  }

  const session = await db.collection<OptionalId<LoginSession>>('login_sessions').findOne(
    { userId, deviceId: normalizedDeviceId },
    { projection: { isActive: 1 } }
  );

  return session?.isActive !== false;
}
