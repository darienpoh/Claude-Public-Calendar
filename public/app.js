// Public calendar viewer. Reads data.json (optionally encrypted) and renders
// a week grid or a day-by-day list. No dependencies, no build step.

const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PASS_KEY = 'pc-passcode';
const PREFS_KEY = 'pc-prefs';
const $ = (id) => document.getElementById(id);

const state = {
  model: null,
  passcode: null,
  view: window.matchMedia('(max-width: 720px)').matches ? 'list' : 'week',
  // 'viewer' = the visitor's device timezone (automatic), 'owner' = wherever the
  // owner is today, or any explicit IANA zone the visitor picked.
  tzMode: 'viewer',
  anchor: null,
};

/* ---------- timezone helpers ---------- */
const fmtCache = new Map();
function partsIn(date, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}
const pad = (n) => String(n).padStart(2, '0');
const keyIn = (date, tz) => { const p = partsIn(date, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
function offsetAt(date, tz) {
  const p = partsIn(date, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}
function zonedToUtc(key, hh, mm, tz) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetAt(new Date(guess), tz);
  ts = guess - offsetAt(new Date(ts), tz);
  return new Date(ts);
}
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const keyToUtcNoon = (key) => new Date(`${key}T12:00:00Z`);
const weekdayIdx = (key) => (keyToUtcNoon(key).getUTCDay() + 6) % 7; // Mon=0
function displayTz() {
  if (state.tzMode === 'viewer') return VIEWER_TZ;
  if (state.tzMode === 'owner') return ownerTzNow();
  return state.tzMode;
}
/** The owner's timezone right now — follows them when they travel. */
function ownerTzNow() {
  const m = state.model;
  return state.dayMap.get(keyIn(new Date(), m.owner.timezone))?.tz || m.owner.timezone;
}
function ownerPlaceNow() {
  const m = state.model;
  const tz = ownerTzNow();
  const day = state.dayMap.get(keyIn(new Date(), m.owner.timezone));
  if (tz === m.owner.timezone) return m.owner.homeCity || cityOf(tz);
  return day?.place || null; // city withheld (came from a busy-only calendar)
}
function gmtLabel(tz, at = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName').value;
  } catch {
    return '';
  }
}
function diffLabel(ownerTz) {
  const diffMin = (offsetAt(new Date(), ownerTz) - offsetAt(new Date(), VIEWER_TZ)) / 60000;
  if (diffMin === 0) return 'same time as you';
  const h = Math.abs(diffMin) / 60;
  const txt = Number.isInteger(h) ? `${h}h` : `${Math.floor(h)}h ${Math.abs(diffMin) % 60}m`;
  return `${txt} ${diffMin > 0 ? 'ahead of' : 'behind'} you`;
}

function fmtTime(date, tz = displayTz()) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(date);
}
function fmtDay(key, opts) {
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(keyToUtcNoon(key));
}
function cityOf(tz) {
  return tz.split('/').pop().replace(/_/g, ' ');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------- Telegram Mini App ---------- */
// When opened from a Telegram bot, Telegram appends #tgWebAppData=… to the URL.
let tg = null;
async function initTelegram() {
  const inTelegram = /tgWebApp/.test(location.hash) || /[?&]tg=1/.test(location.search) || 'TelegramWebviewProxy' in window;
  if (!inTelegram) return;
  await new Promise((resolve) => {
    const sc = document.createElement('script');
    sc.src = 'https://telegram.org/js/telegram-web-app.js';
    sc.onload = sc.onerror = resolve;
    document.head.appendChild(sc);
  });
  tg = window.Telegram?.WebApp || null;
  if (!tg) return;
  tg.ready();
  tg.expand();
  document.documentElement.classList.add('tg');
  const applyTheme = () => {
    const t = tg.themeParams || {};
    const root = document.documentElement.style;
    const set = (v, c) => c && root.setProperty(v, c);
    set('--bg', t.secondary_bg_color || t.bg_color);
    set('--surface', t.bg_color);
    set('--surface-2', t.secondary_bg_color);
    set('--text', t.text_color);
    set('--muted', t.hint_color);
    set('--line', t.section_separator_color || (t.hint_color ? `color-mix(in srgb, ${t.hint_color} 30%, transparent)` : null));
    set('--accent', t.button_color);
    set('--event', t.link_color || t.button_color);
  };
  applyTheme();
  tg.onEvent?.('themeChanged', applyTheme);
}

/* ---------- data loading ---------- */
async function decrypt(payload, passcode) {
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(payload.salt), iterations: payload.iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(payload.iv) }, key, unb64(payload.data));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function fetchData() {
  const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load calendar (HTTP ${res.status})`);
  return res.json();
}

function store(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

async function boot() {
  await initTelegram();
  try {
    const prefs = JSON.parse(load(PREFS_KEY) || '{}');
    if (prefs.view) state.view = prefs.view;
    if (prefs.tzMode) state.tzMode = prefs.tzMode;
  } catch { /* ignore */ }

  let payload;
  try {
    payload = await fetchData();
  } catch (err) {
    document.body.innerHTML = `<p style="padding:24px">${esc(err.message)}</p>`;
    return;
  }

  if (!payload.encrypted) return start(payload);

  const saved = load(PASS_KEY);
  if (saved) {
    try { return start(await decrypt(payload, saved), saved); } catch { store(PASS_KEY, null); }
  }
  $('lock').hidden = false;
  $('lock-input').focus();
  $('lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = $('lock-input').value;
    $('lock-error').textContent = '';
    try {
      const model = await decrypt(payload, pass);
      if ($('lock-remember').checked) store(PASS_KEY, pass);
      $('lock').hidden = true;
      start(model, pass);
    } catch {
      $('lock-error').textContent = 'That passcode didn’t work. Try again?';
    }
  });
}

function start(model, passcode = null) {
  state.model = model;
  state.passcode = passcode;
  state.dayMap = new Map(model.days.map((d) => [d.date, d]));
  state.anchor = keyIn(new Date(), displayTz());
  document.title = `${model.owner.name}’s schedule`;
  $('app').hidden = false;
  wireControls();
  render();
  setInterval(renderNow, 60_000);
  setInterval(refresh, 15 * 60_000);
}

async function refresh() {
  try {
    const payload = await fetchData();
    const model = payload.encrypted ? await decrypt(payload, state.passcode) : payload;
    state.model = model;
    state.dayMap = new Map(model.days.map((d) => [d.date, d]));
    render();
  } catch { /* keep showing the old data */ }
}

/* ---------- controls ---------- */
function wireControls() {
  const m = state.model;
  $('prev').onclick = () => shift(-1);
  $('next').onclick = () => shift(1);
  $('today').onclick = () => { state.anchor = keyIn(new Date(), displayTz()); render(); };
  document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { state.view = b.dataset.view; savePrefs(); render(); }));

  $('tz-select').onchange = (e) => {
    state.tzMode = e.target.value;
    savePrefs();
    render();
  };

  if (m.feed) {
    const url = new URL(m.feed, location.href);
    const webcal = url.href.replace(/^https?:/, 'webcal:');
    $('subscribe').hidden = false;
    $('sub-url').value = url.href;
    $('sub-google').href = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
    $('sub-apple').href = webcal;
    if (tg) {
      // Telegram's in-app browser can't open webcal:// or new tabs itself.
      for (const [id, href] of [['sub-google', $('sub-google').href], ['sub-apple', url.href]]) {
        $(id).onclick = (e) => { e.preventDefault(); tg.openLink(href); };
      }
    }
    $('subscribe').onclick = () => $('sub-dialog').showModal();
    $('sub-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(url.href); $('sub-copy').textContent = 'Copied!'; }
      catch { $('sub-url').select(); }
      setTimeout(() => ($('sub-copy').textContent = 'Copy'), 1500);
    };
  }
}

/** Timezone picker: visitor's own (auto-detected), owner's current, or any zone. */
function buildTzSelect() {
  const m = state.model;
  const sel = $('tz-select');
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  if (!zones.includes(VIEWER_TZ)) zones.push(VIEWER_TZ);
  if (state.tzMode !== 'viewer' && state.tzMode !== 'owner' && !zones.includes(state.tzMode)) state.tzMode = 'viewer';
  const place = ownerPlaceNow();
  const ownerTz = ownerTzNow();
  const opt = (value, label) => `<option value="${esc(value)}"${value === state.tzMode ? ' selected' : ''}>${esc(label)}</option>`;
  sel.innerHTML =
    opt('viewer', `📍 My time · ${cityOf(VIEWER_TZ)} (${gmtLabel(VIEWER_TZ)})`) +
    opt('owner', `🧳 ${m.owner.name}’s time · ${place || gmtLabel(ownerTz)}`) +
    `<optgroup label="Other timezones">${zones.map((z) => opt(z, `${z.replace(/_/g, ' ')} (${gmtLabel(z)})`)).join('')}</optgroup>`;
}

function savePrefs() {
  store(PREFS_KEY, JSON.stringify({ view: state.view, tzMode: state.tzMode }));
}

function shift(dir) {
  state.anchor = addDays(state.anchor, dir * (state.view === 'week' ? 7 : 14));
  render();
}

/* ---------- rendering ---------- */
function render() {
  const m = state.model;
  buildTzSelect();
  $('title').textContent = `${m.owner.name}’s calendar`;
  $('tagline').textContent = m.owner.tagline;
  $('avatar').textContent = m.owner.name.slice(0, 1).toUpperCase();
  const mins = Math.round((Date.now() - new Date(m.generatedAt)) / 60000);
  $('updated').textContent = `Updated ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}`;
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));

  $('legend').innerHTML =
    Object.values(m.statuses).map((s) => `<span><i class="swatch" style="background:${esc(s.color)}"></i>${esc(s.emoji)} ${esc(s.label)}</span>`).join('') +
    `<span><i class="swatch" style="background:var(--busy)"></i>Busy</span>` +
    `<span><i class="swatch" style="background:var(--event)"></i>Plans</span>`;

  renderNow();
  if (state.view === 'week') renderWeek();
  else renderList();
}

function statusOf(dateKey) {
  const day = state.dayMap.get(dateKey);
  if (!day || !day.status) return null;
  return { ...state.model.statuses[day.status], key: day.status, detail: day.detail };
}

function chip(dateKey, { showNone = true } = {}) {
  const s = statusOf(dateKey);
  if (!s) {
    if (!showNone) return '';
    return `<div class="status-chip none">${state.dayMap.get(dateKey)?.work ? esc(state.model.workingLabel) : 'Free day'}</div>${placeLine(dateKey)}`;
  }
  const label = `${s.short}${s.detail ? ` · ${s.detail}` : ''}`;
  return `<div class="status-chip" style="--c:${esc(s.color)}" title="${esc(s.label)}${s.detail ? ` · ${esc(s.detail)}` : ''}">${esc(s.emoji)} ${esc(label)}</div>${placeLine(dateKey, s.detail)}`;
}

/** "📍 Bali · GMT+8" under the chip when the owner is away from home that day. */
function placeLine(dateKey, detail = '') {
  const day = state.dayMap.get(dateKey);
  if (!day || !day.tz || day.tz === state.model.owner.timezone) return '';
  const name = day.place && day.place !== detail ? `${day.place} · ` : '';
  return `<div class="place-line" title="${esc(state.model.owner.name)} is on ${esc(gmtLabel(day.tz, keyToUtcNoon(dateKey)))} time">📍 ${esc(name)}${esc(gmtLabel(day.tz, keyToUtcNoon(dateKey)))}</div>`;
}

/** All timed things (work blocks + events) as {start, end, kind, title, ...}. */
function timedItems() {
  const m = state.model;
  const items = [];
  for (const d of m.days) {
    if (!d.work) continue;
    const s = d.status ? m.statuses[d.status] : null;
    items.push({ kind: 'work', start: new Date(d.work.start), end: new Date(d.work.end), title: m.workingLabel, status: s, ownerDate: d.date });
  }
  for (const e of m.events) {
    if (e.allDay) continue;
    items.push({ ...e, start: new Date(e.start), end: new Date(e.end) });
  }
  return items;
}

function itemLabel(it) {
  if (it.kind === 'work') return it.status ? `${state.model.workingLabel} (${it.status.short})` : state.model.workingLabel;
  return it.title;
}

function renderNow() {
  const m = state.model;
  const now = new Date();
  const homeTz = m.owner.timezone;
  const ownerTz = ownerTzNow();
  const today = keyIn(now, homeTz);
  const s = statusOf(today);
  const items = timedItems().filter((i) => !i.free);
  const current = items.filter((i) => i.start <= now && i.end > now);

  // Find when the current run of back-to-back busy items ends.
  let freeAt = null;
  if (current.length) {
    freeAt = new Date(Math.max(...current.map((i) => i.end)));
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of items) {
        if (i.start <= freeAt && i.end > freeAt) { freeAt = i.end; grew = true; }
      }
    }
  }
  const nextUp = items.filter((i) => i.start > now && keyIn(i.start, ownerTz) === keyIn(now, ownerTz)).sort((a, b) => a.start - b.start)[0];
  const primary = current.find((i) => i.kind === 'event') || current.find((i) => i.kind === 'busy') || current[0];
  const tz = displayTz();

  let headline = s ? `${s.label}${s.detail ? ` · ${s.detail}` : ''} today` : 'No work today';
  if (s && s.working === false) headline = `${s.label}${s.detail ? ` · ${s.detail}` : ''}`;

  let sub;
  if (primary) {
    const what = primary.kind === 'work' ? 'Working' : primary.kind === 'busy' ? 'Busy' : esc(primary.title);
    sub = `<span class="pill busy">● ${what}</span> until ${fmtTime(freeAt, tz)}`;
  } else {
    sub = `<span class="pill free">● Free now</span>`;
    if (nextUp) sub += ` · next: ${esc(itemLabel(nextUp))} at ${fmtTime(nextUp.start, tz)}`;
  }

  const el = $('now');
  el.style.setProperty('--status-color', s?.color || 'var(--muted)');
  el.innerHTML = `
    <div class="big-emoji" aria-hidden="true">${esc(s?.emoji || '🙂')}</div>
    <div class="headline">${esc(headline)}</div>
    <div class="clock"><strong>${fmtTime(now, ownerTz)}</strong>${esc(m.owner.name)} is in ${esc(ownerPlaceNow() || gmtLabel(ownerTz))}<span class="tzdiff">${esc(diffLabel(ownerTz))}</span></div>
    <div class="sub">${sub}</div>`;
}

function weekDays() {
  const start = addDays(state.anchor, -weekdayIdx(state.anchor));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function allDayFor(key) {
  return state.model.events.filter((e) => e.allDay && e.startDate <= key && e.endDate > key);
}

function renderWeek() {
  const tz = displayTz();
  const days = weekDays();
  const todayKey = keyIn(new Date(), tz);
  $('range-label').textContent = rangeLabel(days[0], days[6]);
  $('prev').disabled = days[0] <= state.model.range.start;
  $('next').disabled = days[6] >= state.model.range.end;

  // Lay out each day's timed items in display-tz minutes.
  const items = timedItems();
  const perDay = days.map((key) => {
    const dayStart = zonedToUtc(key, 0, 0, tz);
    const dayEnd = zonedToUtc(addDays(key, 1), 0, 0, tz);
    const toMin = (d, isEnd) => {
      if (d <= dayStart) return 0;
      if (d >= dayEnd) return 24 * 60;
      const p = partsIn(d, tz);
      const v = p.h * 60 + p.mi;
      return isEnd && v === 0 ? 24 * 60 : v;
    };
    return items
      .filter((i) => i.start < dayEnd && i.end > dayStart)
      .map((i) => ({ ...i, a: toMin(i.start, false), b: Math.max(toMin(i.end, true), toMin(i.start, false) + 15) }));
  });

  let minH = 7, maxH = 22;
  for (const list of perDay) for (const i of list) { minH = Math.min(minH, Math.floor(i.a / 60)); maxH = Math.max(maxH, Math.ceil(i.b / 60)); }
  maxH = Math.min(24, maxH);
  const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 44;
  const y = (min) => ((min - minH * 60) / 60) * hourPx;
  const height = (maxH - minH) * hourPx;

  let html = '<div class="week"><div class="corner"></div>';
  for (const key of days) {
    const cls = ['day-head', key === todayKey ? 'today' : '', key < todayKey ? 'past' : ''].join(' ');
    html += `<div class="${cls}"><div class="dname">${fmtDay(key, { weekday: 'short' })}</div><div class="dnum">${fmtDay(key, { day: 'numeric' })}</div>${chip(key)}</div>`;
  }
  html += '<div class="allday-label">all-day</div>';
  for (const key of days) {
    html += `<div class="allday-cell">${allDayFor(key).map((e) => `<div class="allday-item ${e.kind === 'busy' ? 'busy' : ''} ${e.free ? 'free' : ''}" title="${esc(e.title)}">${esc(e.title)}</div>`).join('')}</div>`;
  }

  html += `<div class="gutter" style="height:${height}px">`;
  for (let h = minH + 1; h < maxH; h++) {
    html += `<div class="hlabel" style="top:${y(h * 60)}px">${fmtTime(zonedToUtc('2026-01-05', h, 0, 'UTC'), 'UTC')}</div>`;
  }
  html += '</div>';

  const now = new Date();
  days.forEach((key, idx) => {
    html += `<div class="col ${key === todayKey ? 'today' : ''}" style="height:${height}px">`;
    for (let h = minH + 1; h < maxH; h++) html += `<div class="hline" style="top:${y(h * 60)}px"></div>`;
    const list = perDay[idx];
    for (const w of list.filter((i) => i.kind === 'work')) {
      const color = w.status?.color || 'var(--muted)';
      html += `<div class="work-block" style="--c:${esc(color)};top:${y(w.a)}px;height:${y(w.b) - y(w.a)}px">${esc(itemLabel(w))}<br><span style="font-weight:500">${fmtTime(w.start, tz)} – ${fmtTime(w.end, tz)}</span></div>`;
    }
    const evs = layoutColumns(list.filter((i) => i.kind !== 'work'));
    for (const e of evs) {
      const top = y(e.a), h = Math.max(y(e.b) - top, 18);
      const left = (e.col / e.cols) * 100, width = 100 / e.cols;
      const cls = ['ev', e.kind === 'busy' ? 'busy' : '', e.free ? 'free' : ''].join(' ');
      const time = `${fmtTime(e.start, tz)} – ${fmtTime(e.end, tz)}`;
      html += `<div class="${cls}" style="top:${top}px;height:${h}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px)" title="${esc(e.title)} · ${time}${e.location ? ` · ${esc(e.location)}` : ''}">
        <div class="t">${esc(e.title)}</div>${h > 30 ? `<div class="m">${time}</div>` : ''}${h > 46 && e.location ? `<div class="m">${esc(e.location)}</div>` : ''}</div>`;
    }
    if (key === keyIn(now, tz)) {
      const p = partsIn(now, tz);
      const mm = p.h * 60 + p.mi;
      if (mm >= minH * 60 && mm <= maxH * 60) html += `<div class="now-line" style="top:${y(mm)}px"></div>`;
    }
    html += '</div>';
  });
  html += '</div>';
  $('view').innerHTML = html;
}

/** Assign side-by-side columns to overlapping events. */
function layoutColumns(list) {
  const sorted = [...list].sort((a, b) => a.a - b.a || b.b - a.b);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const colsEnd = [];
    for (const e of cluster) {
      let c = colsEnd.findIndex((end) => end <= e.a);
      if (c === -1) { c = colsEnd.length; colsEnd.push(0); }
      colsEnd[c] = e.b;
      e.col = c;
    }
    for (const e of cluster) e.cols = colsEnd.length;
    out.push(...cluster);
    cluster = [];
  };
  for (const e of sorted) {
    if (e.a >= clusterEnd && cluster.length) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.b);
  }
  if (cluster.length) flush();
  return out;
}

function renderList() {
  const tz = displayTz();
  const todayKey = keyIn(new Date(), tz);
  const days = Array.from({ length: 14 }, (_, i) => addDays(state.anchor, i)).filter((k) => k >= state.model.range.start && k <= state.model.range.end);
  $('range-label').textContent = days.length ? rangeLabel(days[0], days[days.length - 1]) : '';
  $('prev').disabled = state.anchor <= state.model.range.start;
  $('next').disabled = addDays(state.anchor, 14) > state.model.range.end;

  const items = timedItems();
  let html = '<div class="list">';
  for (const key of days) {
    const dayStart = zonedToUtc(key, 0, 0, tz);
    const dayEnd = zonedToUtc(addDays(key, 1), 0, 0, tz);
    const s = statusOf(key);
    const rows = [];
    for (const e of allDayFor(key)) {
      rows.push(`<li><span class="time">All day</span><span class="what"><i class="dot ${e.kind === 'busy' ? 'busy' : ''}"></i>${esc(e.title)}</span></li>`);
    }
    for (const i of items.filter((i) => i.start < dayEnd && i.end > dayStart).sort((a, b) => a.start - b.start)) {
      const st = i.start < dayStart ? '…' : fmtTime(i.start, tz);
      const en = i.end > dayEnd ? '…' : fmtTime(i.end, tz);
      const dot = i.kind === 'work' ? `<i class="dot work" style="--c:${esc(i.status?.color || 'var(--muted)')}"></i>` : `<i class="dot ${i.kind === 'busy' ? 'busy' : ''}"></i>`;
      rows.push(`<li><span class="time">${st} – ${en}</span><span class="what">${dot}<span>${esc(itemLabel(i))}${i.location ? ` <span class="loc">· ${esc(i.location)}</span>` : ''}</span></span></li>`);
    }
    html += `<article class="day-card ${key === todayKey ? 'today' : ''}" style="--c:${esc(s?.color || 'var(--line)')}">
      <div class="date"><div class="dname">${fmtDay(key, { weekday: 'short' })}</div><div class="dnum">${fmtDay(key, { day: 'numeric' })}</div><div class="mon">${fmtDay(key, { month: 'short' })}</div></div>
      <div><div class="status-line">${chip(key)}</div>
      ${rows.length ? `<ul class="items">${rows.join('')}</ul>` : '<p class="empty">Nothing scheduled — free all day.</p>'}</div>
    </article>`;
  }
  html += '</div>';
  $('view').innerHTML = html;
}

function rangeLabel(a, b) {
  return `${fmtDay(a, { day: 'numeric', month: 'short' })} – ${fmtDay(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

boot();
