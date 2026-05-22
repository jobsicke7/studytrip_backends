import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const srcDir = join(rootDir, 'src');
const pollMs = 700;
const watchExtensions = new Set(['.ts', '.js', '.json']);

let child = null;
let restarting = false;
let snapshot = new Map();

function getBunCommand() {
  const candidates = [
    process.env.BUN_EXE,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.bun', 'bin', 'bun.exe') : null,
    process.env.HOME ? join(process.env.HOME, '.bun', 'bin', 'bun') : null,
    'bun',
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === 'bun' || existsSync(candidate)) ?? 'bun';
}

function scanFiles(dir, files = []) {
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && watchExtensions.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function getSnapshot() {
  const next = new Map();
  for (const file of scanFiles(srcDir)) {
    const stat = statSync(file);
    next.set(file, `${stat.mtimeMs}:${stat.size}`);
  }
  return next;
}

function changed(previous, next) {
  if (previous.size !== next.size) return true;

  for (const [file, signature] of next) {
    if (previous.get(file) !== signature) return true;
  }

  return false;
}

function startServer() {
  child = spawn(getBunCommand(), ['src/index.ts'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`[dev] failed to start Bun runtime: ${error.message}`);
    child = null;
  });

  child.on('exit', (code, signal) => {
    if (!restarting && code !== 0) {
      console.log(`[dev] server exited with ${signal ?? code}`);
    }
    child = null;
  });
}

function restartServer() {
  if (restarting) return;

  restarting = true;
  console.log('[dev] change detected, restarting...');

  const previousChild = child;
  if (!previousChild) {
    restarting = false;
    startServer();
    return;
  }

  previousChild.once('exit', () => {
    restarting = false;
    startServer();
  });
  previousChild.kill();
}

function stop() {
  if (child) {
    child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

snapshot = getSnapshot();
startServer();

setInterval(() => {
  const nextSnapshot = getSnapshot();
  if (changed(snapshot, nextSnapshot)) {
    snapshot = nextSnapshot;
    restartServer();
  }
}, pollMs);
