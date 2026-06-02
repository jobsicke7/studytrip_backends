import { Elysia } from 'elysia';
import { createHash } from 'node:crypto';

import type { Env } from '../config.js';

type AppSingleton = {
  decorator: {
    env: Env;
  };
  store: {};
  derive: {};
  resolve: {};
};

const timerFontStyleSeeds = [
  { id: 'jalnan', label: '잘난체', fontFamily: 'TimerFontJalnan', fontFile: 'Jalnan2.otf' },
  { id: 'pretendard', label: '프리텐다드', fontFamily: 'TimerFontPretendard', fontFile: 'PretendardVariable.ttf' },
  { id: 'jejudoldam', label: '제주돌담체', fontFamily: 'TimerFontJejuDoldam', fontFile: 'EF_jejudoldam(OTF).otf' },
  { id: 'inklip', label: '손글씨', fontFamily: 'TimerFontInklip', fontFile: 'THEFACESHOP+INKLIPQUID(윈도우용).ttf' },
] as const;

const themeAccentSeeds = [
  { id: 'blue', label: '파란색', primary: '#BFDBFE', soft: 'rgba(147,197,253,0.16)', border: 'rgba(147,197,253,0.3)', textOnPrimary: '#0F172A' },
  { id: 'beige', label: '베이지', primary: '#F4DFC0', soft: 'rgba(244,223,192,0.16)', border: 'rgba(244,223,192,0.3)', textOnPrimary: '#1B130B' },
  { id: 'red', label: '붉은색', primary: '#FCA5A5', soft: 'rgba(252,165,165,0.16)', border: 'rgba(252,165,165,0.32)', textOnPrimary: '#1F1111' },
  { id: 'purple', label: '보라색', primary: '#C4B5FD', soft: 'rgba(196,181,253,0.16)', border: 'rgba(196,181,253,0.32)', textOnPrimary: '#17111F' },
  { id: 'pink', label: '핑크색', primary: '#F9A8D4', soft: 'rgba(249,168,212,0.16)', border: 'rgba(249,168,212,0.32)', textOnPrimary: '#1F1119' },
  { id: 'green', label: '초록색', primary: '#A7F3D0', soft: 'rgba(167,243,208,0.16)', border: 'rgba(167,243,208,0.32)', textOnPrimary: '#0D1F17' },
  { id: 'cyan', label: '시안', primary: '#67E8F9', soft: 'rgba(103,232,249,0.16)', border: 'rgba(103,232,249,0.32)', textOnPrimary: '#071D22' },
] as const;

const allowedFontFiles = new Set(timerFontStyleSeeds.map((font) => font.fontFile));

function getFontContentType(fontFile: string) {
  const lowerFontFile = fontFile.toLowerCase();
  if (lowerFontFile.endsWith('.otf')) return 'font/otf';
  if (lowerFontFile.endsWith('.ttf')) return 'font/ttf';
  if (lowerFontFile.endsWith('.woff2')) return 'font/woff2';
  if (lowerFontFile.endsWith('.woff')) return 'font/woff';
  return 'application/octet-stream';
}

function buildR2FontUrl(env: Env, fontFile: string) {
  const fontBaseUrl = env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
  const fontPrefix = env.FONT_KEY_PREFIX.replace(/^\/|\/$/g, '');
  return fontBaseUrl ? `${fontBaseUrl}/${fontPrefix}/${encodeURIComponent(fontFile)}` : null;
}

function buildAppConfig(env: Env, apiBaseUrl: string) {
  const whiteNoiseBaseUrl = env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
  const whiteNoisePrefix = env.WHITE_NOISE_KEY_PREFIX.replace(/^\/|\/$/g, '');
  const backgroundBaseUrl = env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
  const backgroundPrefix = env.BACKGROUND_KEY_PREFIX.replace(/^\/|\/$/g, '');
  const getBackgroundUrl = (id: string) =>
    id !== 'none' && backgroundBaseUrl ? `${backgroundBaseUrl}/${backgroundPrefix}/${id}.png` : null;
  const getWhiteNoiseUrl = (id: string) =>
    id !== 'none' && whiteNoiseBaseUrl ? `${whiteNoiseBaseUrl}/${whiteNoisePrefix}/${id}.mp3` : null;
  const getFontUrl = (fontFile: string | null) =>
    fontFile && apiBaseUrl ? `${apiBaseUrl}/app/fonts/${encodeURIComponent(fontFile)}` : null;

  const config = {
    auth: {
      showTestLoginButton: env.SHOW_TEST_LOGIN_BUTTON,
    },
    backgrounds: [
      { id: 'none', label: '배경 없음' },
      { id: 'seoul_city_view', label: '서울 도시뷰' },
      { id: 'japan_street', label: '일본 거리' },
      { id: 'fire', label: '모닥불' },
      { id: 'library', label: '도서관' },
      { id: 'sakuraroad', label: '벚꽃 길' },
      { id: 'space', label: '우주' },
      { id: 'japanrail', label: '일본 철도역' },
      { id: 'oceanroad', label: '해변 도로' },
    ].map((background) => ({
      ...background,
      imageUrl: getBackgroundUrl(background.id),
    })),
    whiteNoise: {
      options: [
        { id: 'none', label: '사용 안 함', icon: 'volume-off' },
        { id: 'rain', label: '빗소리', icon: 'water-drop' },
        { id: 'waves', label: '파도 소리', icon: 'waves' },
        { id: 'forest', label: '숲 소리', icon: 'forest' },
        { id: 'cafe', label: '카페 소음', icon: 'local-cafe' },
        { id: 'city', label: '도시 소음', icon: 'location-city' },
        { id: 'airplane', label: '비행기 기내 소음', icon: 'flight' },
      ].map((option) => ({
        ...option,
        streamUrl: getWhiteNoiseUrl(option.id),
      })),
    },
    clockFormats: [
      { id: '12h', label: '12시간제', preview: '2:24' },
      { id: '24h', label: '24시간제', preview: '14:24' },
    ],
    timerFontStyles: timerFontStyleSeeds.map(({ fontFile, ...font }) => ({
      ...font,
      fontUrl: getFontUrl(fontFile),
    })),
    themeAccents: themeAccentSeeds,
  };

  return {
    revision: createHash('sha1').update(JSON.stringify(config)).digest('hex'),
    ...config,
  };
}

export const appConfigRoutes = new Elysia<'', AppSingleton>()
  .get('/app/config', ({ env, query, request }) => {
    // Determine external API origin. Prefer explicit env override, then
    // X-Forwarded-* headers (set by reverse proxies), then request.url origin.
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
    const apiOrigin =
      (env.EXTERNAL_API_ORIGIN && env.EXTERNAL_API_ORIGIN.replace(/\/$/, '')) ||
      (forwardedProto && forwardedHost ? `${forwardedProto}://${forwardedHost}` : new URL(request.url).origin);
    const config = buildAppConfig(env, apiOrigin);
    if (query.rev === config.revision) {
      return {
        revision: config.revision,
        changed: false,
      };
    }

    return {
      ...config,
      changed: true,
    };
  })
  .get('/app/fonts/:fontFile', async ({ env, params, status }) => {
    const fontFile = decodeURIComponent(params.fontFile);
    if (!allowedFontFiles.has(fontFile as (typeof timerFontStyleSeeds)[number]['fontFile'])) {
      return status(404, { error: 'Font not found' });
    }

    const fontUrl = buildR2FontUrl(env, fontFile);
    if (!fontUrl) {
      return status(404, { error: 'Font storage is not configured' });
    }

    const fontResponse = await fetch(fontUrl);
    if (!fontResponse.ok || !fontResponse.body) {
      return status(404, { error: 'Font not found' });
    }

    return new Response(fontResponse.body, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
        'Content-Type': fontResponse.headers.get('content-type') ?? getFontContentType(fontFile),
      },
    });
  });
