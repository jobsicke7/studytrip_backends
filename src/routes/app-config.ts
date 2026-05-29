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

function buildAppConfig(env: Env) {
  const whiteNoiseBaseUrl = env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
  const whiteNoisePrefix = env.WHITE_NOISE_KEY_PREFIX.replace(/^\/|\/$/g, '');
  const backgroundBaseUrl = env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
  const backgroundPrefix = env.BACKGROUND_KEY_PREFIX.replace(/^\/|\/$/g, '');
  const whiteNoiseOptions = [
    { id: 'none', label: '사용 안 함', icon: 'volume-off' },
    { id: 'rain', label: '빗소리', icon: 'water-drop' },
    { id: 'waves', label: '파도 소리', icon: 'waves' },
    { id: 'forest', label: '숲 소리', icon: 'forest' },
    { id: 'cafe', label: '카페 소음', icon: 'local-cafe' },
    { id: 'city', label: '도시 소음', icon: 'location-city' },
    { id: 'airplane', label: '비행기 기내 소음', icon: 'flight' },
  ];

  const config = {
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
      imageUrl:
        background.id !== 'none' && backgroundBaseUrl
          ? `${backgroundBaseUrl}/${backgroundPrefix}/${background.id}.png`
          : null,
    })),
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

  return {
    revision: createHash('sha1').update(JSON.stringify(config)).digest('hex'),
    ...config,
  };
}

export const appConfigRoutes = new Elysia<'', AppSingleton>().get('/app/config', ({ env, query }) => {
  const config = buildAppConfig(env);
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
});
