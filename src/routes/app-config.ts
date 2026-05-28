import { Elysia } from 'elysia';

import type { Env } from '../config.js';

type AppSingleton = {
  decorator: {
    env: Env;
  };
  store: {};
  derive: {};
  resolve: {};
};

function buildAppConfig(env: Env) {
  const whiteNoiseBaseUrl = env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
  const whiteNoisePrefix = env.WHITE_NOISE_KEY_PREFIX.replace(/^\/|\/$/g, '');
  const whiteNoiseOptions = [
    { id: 'none', label: '사용 안 함' },
    { id: 'rain', label: '빗소리' },
    { id: 'waves', label: '파도 소리' },
    { id: 'forest', label: '숲 소리' },
    { id: 'cafe', label: '카페 소음' },
    { id: 'white', label: '화이트 노이즈' },
    { id: 'brown', label: '브라운 노이즈' },
  ];

  return {
    brand: {
      name: '타이머',
    },
    timerModes: [
      { mode: 'basic', label: '기본 타이머', description: '' },
      { mode: 'pomodoro', label: '뽀모도로', description: '' },
    ],
    defaultSubjects: [
      { subjectId: 'korean', label: '국어', totalSeconds: 0 },
      { subjectId: 'math', label: '수학', totalSeconds: 0 },
      { subjectId: 'english', label: '영어', totalSeconds: 0 },
      { subjectId: 'science', label: '과학', totalSeconds: 0 },
      { subjectId: 'society', label: '사회', totalSeconds: 0 },
    ],
    backgrounds: [
      { id: 'none', label: '배경 없음', assetKey: null },
      { id: 'seoul_city_view', label: '서울 도시뷰', assetKey: 'seoul_city_view' },
      { id: 'japan_street', label: '일본 거리', assetKey: 'japan_street' },
      { id: 'fire', label: '모닥불', assetKey: 'fire' },
      { id: 'library', label: '도서관', assetKey: 'library' },
    ],
    locationBoundary: {
      latitude: env.SCHOOL_LAT,
      longitude: env.SCHOOL_LNG,
      radiusMeters: env.SCHOOL_RADIUS_M,
    },
    records: {
      weekdayLabels: ['일', '월', '화', '수', '목', '금', '토'],
    },
    whiteNoise: {
      options: whiteNoiseOptions.map((option) => ({
        ...option,
        streamUrl:
          option.id !== 'none' && whiteNoiseBaseUrl
            ? `${whiteNoiseBaseUrl}/${whiteNoisePrefix}/${option.id}.mp3`
            : null,
      })),
    },
  };
}

export const appConfigRoutes = new Elysia<'', AppSingleton>().get('/app/config', ({ env }) => buildAppConfig(env));
