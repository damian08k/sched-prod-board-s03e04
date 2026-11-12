// Records the plan's flows on the deployed board: open-board, ack-incident, watch-board.
// Usage: node scripts/record.mjs <board url> <out name> [maxWatchSeconds]
// Writes recordings/<out>.webm and recordings/<out>.json (moments in mm:ss, ack receipts). Not committed.
import { chromium } from 'playwright';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';

const [url, out = 'step1', maxWatch = '540'] = process.argv.slice(2);
mkdirSync('recordings/raw', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: 'recordings/raw', size: { width: 1280, height: 720 } },
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
});
// A visible pointer for the video only (headless video has no cursor). Not part of the board.
await ctx.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(220,0,80,.55);border:2px solid #fff;pointer-events:none;left:-40px;top:-40px;transition:transform .1s';
    document.body.append(dot);
    addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; });
    addEventListener('mousedown', () => (dot.style.transform = 'scale(1.8)'));
    addEventListener('mouseup', () => (dot.style.transform = ''));
  });
});

const page = await ctx.newPage();
const t0 = Date.now();
const mmss = (t = Date.now()) => {
  const s = Math.max(0, Math.round((t - t0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const moments = [];
const mark = (flow, note, extra = {}) => {
  const m = { flow, at: mmss(), note, ...extra };
  moments.push(m);
  console.log(m.at, flow, note);
};
const acks = [];
page.on('response', async (res) => {
  if (!res.url().includes('/ack?')) return;
  try {
    const body = await res.json();
    acks.push({ at: mmss(), id: body.id, ackedAt: body.ackedAt, receipt: body.receipt });
  } catch {}
});

// open-board
await page.waitForTimeout(800);
await page.goto(url);
mark('open-board', 'page opened, loader showing');
await page.getByTestId('incident-row').first().waitFor({ timeout: 20000 });
const sha = await page.locator('meta[name="build"]').getAttribute('content');
const firstIds = await page.$$eval('[data-testid="incident-row"]', (r) => r.map((x) => x.dataset.id));
mark('open-board', `incidents on screen: ${firstIds.length}, newest ${firstIds[0]}`, { sha });
await page.mouse.move(640, 690, { steps: 15 });
await page.getByTestId('build-sha').hover();
await page.waitForTimeout(2500);

// ack-incident, the way a person does it: aim at the top row's Ack, then click that spot on the screen.
// The click goes to whatever is under the pointer at that moment (page.mouse), not to a re-resolved element.
const meant = await page.locator('[data-testid="incident-row"]').first().getAttribute('data-id');
const box = await page.locator(`[data-id="${meant}"] [data-testid="ack"]`).boundingBox();
const x = box.x + box.width / 2, y = box.y + box.height / 2;
await page.mouse.move(x, y, { steps: 25 });
mark('ack-incident', `pointer on Ack of ${meant} (the row I mean)`, { id: meant });
// The person reads the row, then clicks. The list keeps changing meanwhile.
const until = Date.now() + Number(maxWatch) * 1000;
let landed = null;
while (Date.now() < until) {
  const top = await page.locator('[data-testid="incident-row"]').first().getAttribute('data-id');
  if (!firstIds.includes(top)) { landed = top; break; }
  await page.waitForTimeout(30);
}
mark('watch-board', `new incident ${landed} landed on top, list moved down one row`, { id: landed });
await page.waitForTimeout(120);
await page.mouse.click(x, y);
const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="incident-row"]')?.dataset.id, [x, y]);
mark('ack-incident', `clicked the same spot; the row there is ${under}`, { meant, clicked: under });
await page.waitForTimeout(1500);
const ackedIds = await page.$$eval('[data-testid="acked"]', (m) => m.map((x) => x.closest('[data-testid="incident-row"]').dataset.id));
mark('ack-incident', `acked rows: ${ackedIds.join(', ') || 'none'}; meant ${meant}`, { ackedIds, meant });
await page.mouse.move(1100, 300, { steps: 20 });
await page.waitForTimeout(4000);
mark('watch-board', 'still open, no reload');

const video = page.video();
await ctx.close();
await browser.close();
const raw = await video.path();
renameSync(raw, `recordings/${out}.webm`);
writeFileSync(`recordings/${out}.json`, JSON.stringify({ url, sha, startedAt: new Date(t0).toISOString(), moments, acks }, null, 2));
console.log(`recordings/${out}.webm`);
