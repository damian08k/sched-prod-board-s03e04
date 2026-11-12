import { fetchIncidents, ack } from './api.js';

const REFRESH_MS = 2000; // R4

const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const status = document.querySelector('.status');
const newBar = document.querySelector('[data-testid="new-bar"]');
const updated = document.querySelector('.updated'); // shows on-call that the board is current (R4)

/** id -> <li>. Rows are kept across refreshes, so an acked mark and a click in flight survive them. */
const rows = new Map();
/** id -> ackedAt, for rows acked from this board. */
const acked = new Map();

// R5: the viewer's own zone and the viewer's own date order (dd/mm for en-GB, de, fr, en-NZ …).
const timeFormat = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});
const shortTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function localTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFormat.format(d);
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function markAcked(li, ackedAt) {
  const mark = el('span', { 'data-testid': 'acked', class: 'acked' }, `acked ${localTimeShort(ackedAt)}`);
  const button = li.querySelector('[data-testid="ack"]');
  if (button) button.replaceWith(mark);
  else li.append(mark);
  li.classList.add('is-acked');
}

function localTimeShort(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : shortTime.format(d);
}

async function onAck(id, li, button) {
  button.disabled = true;
  button.textContent = 'Acking…';
  try {
    const reply = await ack(id); // R2
    acked.set(id, reply.ackedAt);
    markAcked(li, reply.ackedAt);
  } catch (err) {
    console.error(err);
    button.disabled = false;
    button.textContent = 'Ack';
    showStatus(`Ack failed for ${id}. Try again.`);
  }
}

function createRow(i) {
  const li = el('li', { 'data-testid': 'incident-row', 'data-id': i.id });
  li.append(
    el('span', { class: 'id' }, i.id),
    el('span', { class: 'sev' }),
    el('span', { class: 'what' }),
    el('time'),
  );
  if (acked.has(i.id)) {
    markAcked(li, acked.get(i.id));
  } else {
    const button = el('button', { type: 'button', 'data-testid': 'ack', class: 'ack' }, 'Ack');
    button.addEventListener('click', () => onAck(i.id, li, button));
    li.append(button);
  }
  return li;
}

function updateRow(li, i) {
  li.className = `row ${i.severity}${acked.has(i.id) ? ' is-acked' : ''}`;
  li.querySelector('.sev').textContent = i.severity;
  li.querySelector('.what').textContent = `${i.service} · ${i.region} · ${i.summary}`;
  const time = li.querySelector('time');
  if (time.getAttribute('datetime') !== i.openedAt) {
    time.setAttribute('datetime', i.openedAt); // full UTC value stays in the attribute
    time.textContent = localTime(i.openedAt);
    time.title = i.openedAt;
  }
}

/** Incidents that came in after the list was on screen, newest first, waiting behind the "N new" bar. */
let pending = [];

const newest = (a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0);

/** Puts incidents on top of the list, newest first. Rows already on screen are never moved or removed. */
function prepend(incidents) {
  const first = list.firstChild;
  for (const i of [...incidents].sort(newest)) {
    const li = createRow(i);
    rows.set(i.id, li);
    updateRow(li, i);
    list.insertBefore(li, first);
  }
}

/**
 * R1 (as product decided, 2026-11-12): the list holds still while it is on screen. Rows on screen are
 * updated in place; new incidents wait behind the "N new" bar and come in when on-call clicks it.
 */
function render(incidents) {
  const fresh = [];
  for (const i of incidents) {
    const li = rows.get(i.id);
    if (li) updateRow(li, i);
    else if (!pending.some((p) => p.id === i.id)) fresh.push(i);
    else pending = pending.map((p) => (p.id === i.id ? i : p));
  }
  if (rows.size === 0) {
    prepend([...pending, ...fresh]); // nothing on screen yet, so nothing can move under the pointer
    pending = [];
  } else {
    pending = [...pending, ...fresh].sort(newest);
  }
  showNewBar();
  const none = rows.size === 0;
  empty.hidden = !none;
  list.hidden = none;
}

/** The bar sits in a slot of fixed height, so showing it never moves the list either. */
function showNewBar() {
  newBar.hidden = pending.length === 0;
  newBar.textContent = pending.length === 1 ? '1 new incident · show' : `${pending.length} new incidents · show`;
}

newBar.addEventListener('click', () => {
  prepend(pending);
  pending = [];
  showNewBar();
});

let statusTimer;
function showStatus(text) {
  status.textContent = text;
  status.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.hidden = true), 5000);
}

let loaded = false;
async function refresh() {
  try {
    const page = await fetchIncidents();
    render(page.incidents);
    updated.textContent = `updated ${localTimeShort(page.updatedAt || new Date().toISOString())}`;
    if (!loaded) {
      loaded = true;
      loader.remove(); // R3: gone once incidents load
    }
  } catch (err) {
    console.error(err);
    showStatus(loaded ? 'Could not refresh. Retrying…' : 'Could not load incidents. Retrying…');
  } finally {
    setTimeout(refresh, REFRESH_MS); // R4: every 2 s while open, never two requests at once
  }
}

refresh();
