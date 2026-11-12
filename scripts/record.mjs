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

// ack-incident: ack the newest unacked incident
const row = page.locator('[data-testid="incident-row"]:has([data-testid="ack"])').first();
const ackId = await row.getAttribute('data-id');
const button = row.getByTestId('ack');
await button.hover();
await page.waitForTimeout(1200);
await button.click();
mark('ack-incident', `clicked Ack on ${ackId}`, { id: ackId });
await page.locator(`[data-id="${ackId}"] [data-testid="acked"]`).waitFor({ timeout: 10000 });
mark('ack-incident', `${ackId} marked acked`, { id: ackId });
await page.mouse.move(1000, 120, { steps: 20 });
await page.waitForTimeout(3000);

// watch-board: keep it open until a new incident shows on top (or maxWatch seconds)
mark('watch-board', 'watching, no reload');
const until = Date.now() + Number(maxWatch) * 1000;
let newId = null;
while (Date.now() < until) {
  const top = await page.locator('[data-testid="incident-row"]').first().getAttribute('data-id');
  if (!firstIds.includes(top)) {
    newId = top;
    break;
  }
  await page.waitForTimeout(250);
}
if (newId) mark('watch-board', `new incident ${newId} appeared on top without reload`, { id: newId });
const stillAcked = await page.locator(`[data-id="${ackId}"] [data-testid="acked"]`).count();
mark('watch-board', `${ackId} still acked after refreshes: ${stillAcked === 1}`);
await page.waitForTimeout(4000);

const video = page.video();
await ctx.close();
await browser.close();
const raw = await video.path();
renameSync(raw, `recordings/${out}.webm`);
writeFileSync(`recordings/${out}.json`, JSON.stringify({ url, sha, startedAt: new Date(t0).toISOString(), moments, acks }, null, 2));
console.log(`recordings/${out}.webm`);
