// Checks the four issues against dist/ with a fake incident API (no real acks are sent).
// Run: npm run build && node tests/board.test.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    const body = await readFile(join('dist', path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': types[extname(path || '.html')] ?? 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;

function fakeApi(page, state) {
  return page.route('**/challenges/show-me-when/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/incidents')) {
      state.polls.push(Date.now());
      if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
      state.delay = 0;
      return route.fulfill({ json: { updatedAt: new Date().toISOString(), incidents: state.incidents, cursor: `c${state.polls.length}` } });
    }
    if (url.pathname.endsWith('/ack')) {
      state.acks.push({ id: url.searchParams.get('id'), cursor: url.searchParams.get('cursor') });
      return route.fulfill({ json: { id: url.searchParams.get('id'), ackedAt: new Date().toISOString(), receipt: 'r' } });
    }
    return route.abort();
  });
}

const inc = (id, openedAt) => ({ id, service: 'booking-api', region: 'eu-west', summary: `summary ${id}`, severity: 'sev2', openedAt });
const browser = await chromium.launch({ channel: 'chrome' });
let failed = 0;
async function check(name, fn, ctxOpts = {}) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await fn(page);
    assert.deepEqual(errors, []);
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`);
  }
  await ctx.close();
}

const ids = (page) => page.$$eval('[data-testid="incident-row"]', (rs) => rs.map((r) => r.dataset.id));

await check('SCHED-4512 loader shows until incidents load', async (page) => {
  const state = { incidents: [inc('INC-1', '2026-11-12T03:03:00.000Z')], polls: [], acks: [], delay: 1200 };
  await fakeApi(page, state);
  await page.goto(base);
  await page.getByTestId('loader').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('incident-row').count(), 0);
  await page.getByTestId('incident-row').first().waitFor();
  assert.equal(await page.getByTestId('loader').count(), 0);
});

await check('SCHED-4515 list holds still; "N new" bar brings new incidents in on click; refresh every 2 s', async (page) => {
  await page.addInitScript(() => {
    window.__removed = 0;
    new MutationObserver((rs) => rs.forEach((r) => r.removedNodes.forEach((n) => n.nodeType === 1 && n.matches('[data-testid="incident-row"]') && window.__removed++))).observe(document, { childList: true, subtree: true });
  });
  const state = { incidents: [inc('INC-2', '2026-11-12T03:02:00.000Z'), inc('INC-1', '2026-11-12T03:01:00.000Z')], polls: [], acks: [] };
  await fakeApi(page, state);
  await page.goto(base);
  await page.getByTestId('incident-row').first().waitFor();
  assert.deepEqual(await ids(page), ['INC-2', 'INC-1']);
  assert.equal(await page.getByTestId('new-bar').isVisible(), false);
  const y0 = (await page.locator('[data-id="INC-2"]').boundingBox()).y;
  state.incidents = [inc('INC-4', '2026-11-12T03:04:00.000Z'), inc('INC-3', '2026-11-12T03:03:00.000Z'), ...state.incidents];
  await page.getByTestId('new-bar').waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(await page.getByTestId('new-bar').textContent(), '2 new incidents · show');
  assert.deepEqual(await ids(page), ['INC-2', 'INC-1']);
  assert.equal((await page.locator('[data-id="INC-2"]').boundingBox()).y, y0, 'the bar moved the list');
  await page.getByTestId('new-bar').click();
  assert.deepEqual(await ids(page), ['INC-4', 'INC-3', 'INC-2', 'INC-1']);
  assert.equal(await page.getByTestId('new-bar').isVisible(), false);
  assert.equal(await page.locator('[data-id="INC-4"] [data-testid="ack"]').count(), 1);
  assert.equal(await page.evaluate(() => window.__removed), 0);
  await page.waitForTimeout(4500);
  const gaps = state.polls.slice(1).map((t, i) => t - state.polls[i]);
  assert.ok(gaps.every((g) => g >= 1900 && g < 3000), `poll gaps ${gaps}`);
});

await check('SCHED-4511 Ack acks that incident and the mark survives a refresh', async (page) => {
  const state = { incidents: [inc('INC-2', '2026-11-12T03:02:00.000Z'), inc('INC-1', '2026-11-12T03:01:00.000Z')], polls: [], acks: [] };
  await fakeApi(page, state);
  await page.goto(base);
  await page.locator('[data-id="INC-1"] [data-testid="ack"]').click();
  await page.locator('[data-id="INC-1"] [data-testid="acked"]').waitFor();
  assert.deepEqual(state.acks.map((a) => a.id), ['INC-1']);
  assert.ok(state.acks[0].cursor?.startsWith('c'));
  const polls = state.polls.length;
  await page.waitForFunction((n) => true, polls); // let the next refresh pass
  await page.waitForTimeout(2500);
  assert.ok(state.polls.length > polls);
  assert.equal(await page.locator('[data-id="INC-1"] [data-testid="acked"]').count(), 1);
  assert.equal(await page.locator('[data-id="INC-1"] [data-testid="ack"]').count(), 0);
  assert.equal(await page.locator('[data-id="INC-2"] [data-testid="ack"]').count(), 1);
});

await check('SCHED-4515 ack like a person while a new incident lands: the ack goes to the row aimed at', async (page) => {
  const state = { incidents: [inc('INC-3', '2026-11-12T03:03:00.000Z'), inc('INC-2', '2026-11-12T03:02:00.000Z'), inc('INC-1', '2026-11-12T03:01:00.000Z')], polls: [], acks: [] };
  await fakeApi(page, state);
  await page.goto(base);
  const box = await page.locator('[data-id="INC-3"] [data-testid="ack"]').boundingBox();
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y, { steps: 8 });
  state.incidents = [inc('INC-9', '2026-11-12T03:09:00.000Z'), ...state.incidents];
  await page.getByTestId('new-bar').waitFor({ state: 'visible', timeout: 3000 });
  await page.mouse.click(x, y);
  await page.locator('[data-id="INC-3"] [data-testid="acked"]').waitFor({ timeout: 3000 });
  assert.deepEqual(state.acks.map((a) => a.id), ['INC-3']);
}, { viewport: { width: 1280, height: 800 } });

for (const [zone, locale, expect] of [
  ['Pacific/Auckland', 'en-NZ', /12\/11\/2026, 0?4:03/],
  ['Europe/Berlin', 'de-DE', /12\.11\.2026, 04:03/],
  ['America/New_York', 'en-US', /11\/11\/2026, 10:03/],
]) {
  await check(`SCHED-4514 local time in ${zone} (${locale})`, async (page) => {
    const state = { incidents: [inc('INC-1', '2026-11-12T03:03:00.000Z')], polls: [], acks: [] };
    await fakeApi(page, state);
    await page.goto(base);
    const time = page.locator('[data-id="INC-1"] time');
    await time.waitFor();
    assert.equal(await time.getAttribute('datetime'), '2026-11-12T03:03:00.000Z');
    const text = await time.textContent();
    assert.match(text, expect, text);
  }, { timezoneId: zone, locale });
}

await check('empty state and build sha', async (page) => {
  const state = { incidents: [], polls: [], acks: [] };
  await fakeApi(page, state);
  await page.goto(base);
  await page.getByTestId('empty').waitFor({ state: 'visible' });
  const meta = await page.locator('meta[name="build"]').getAttribute('content');
  assert.match(meta, /^[0-9a-f]{40}$/);
  assert.equal((await page.getByTestId('build-sha').textContent()).trim(), meta);
});

await browser.close();
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
