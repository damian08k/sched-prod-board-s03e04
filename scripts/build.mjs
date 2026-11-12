// Builds dist/ from app/: stamps the git sha (R6) and writes config.js from ../.session (never committed).
import { cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const sha = execSync('git rev-parse HEAD').toString().trim();
const dirty = execSync('git status --porcelain -- app').toString().trim();
if (dirty) throw new Error(`app/ has uncommitted changes; commit first so the sha names this build:\n${dirty}`);
const session = readFileSync(new URL('../../.session', import.meta.url), 'utf8').trim();

rmSync('dist', { recursive: true, force: true });
cpSync('app', 'dist', { recursive: true });
const html = readFileSync('dist/index.html', 'utf8').replaceAll('__BUILD_SHA__', sha);
writeFileSync('dist/index.html', html);
writeFileSync(
  'dist/config.js',
  `export const API = 'https://hq.mega.dev/challenges/show-me-when/api';\nexport const SESSION = '${session}';\n`,
);
console.log(`dist/ built at ${sha}`);
