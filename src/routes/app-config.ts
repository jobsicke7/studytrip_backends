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
  return {
    brand: {
      name: 'Studytrip',
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
      { id: 'seoul-city-view', label: '서울 도시뷰', assetKey: 'seoul_city_view' },
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
  };
}

export const appConfigRoutes = new Elysia<'', AppSingleton>().get('/app/config', ({ env }) => buildAppConfig(env));
