import { Elysia } from 'elysia';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const quotesPath = resolve(currentDir, '..', '..', 'content', 'quotes.txt');
const fallbackQuotes = [
  '지금의 한 페이지가 내일의 기준을 바꾼다.',
  '작게 시작해도 멈추지 않으면 충분히 멀리 간다.',
];

let cachedQuotes: string[] | null = null;

async function loadQuotes() {
  if (cachedQuotes) {
    return cachedQuotes;
  }

  try {
    const raw = await readFile(quotesPath, 'utf8');
    cachedQuotes = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    cachedQuotes = fallbackQuotes;
  }

  return cachedQuotes.length > 0 ? cachedQuotes : fallbackQuotes;
}

export const quoteRoutes = new Elysia().get('/app/quote', async () => {
  const quotes = await loadQuotes();
  const index = Math.floor(Math.random() * quotes.length);
  return {
    quote: quotes[index] ?? fallbackQuotes[0],
  };
});
