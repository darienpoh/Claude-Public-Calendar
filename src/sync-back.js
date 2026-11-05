// Sync-back: mirror personal commitments into the work calendar as private
// "busy" blocks so colleagues can't book over them.
//
// Safety rules:
//  - Only events created by this tool (tagged with a private extended property)
//    are ever updated or deleted. Your real work events are never touched.
//  - Only the future is touched (now → lookaheadDays).
//  - Nothing about personal events is logged (CI logs on public repos are public).

import { createHash } from 'node:crypto';
import { addDays } from './time.js';
import { SYNC_MARKER } from './google.js';

export const SYNC_DEFAULTS = {
  enabled: false,
  provider: 'google',
  calendarId: 'primary',
  fromSources: ['personal'],
  mode: 'workingHours', // 'workingHours' | 'tagged' | 'all'
  blockTag: '#block',
  skipTag: '#noblock',
  title: 'Personal commitment',
  copyTitle: false,
  includeAllDay: false,
  bufferMinutes: 0,
  lookaheadDays: 30,
  colorId: '8', // Google "Graphite"
};

export function syncSettings(config) {
  return { ...SYNC_DEFAULTS, ...(config.syncBack || {}) };
}

const keyOf = (ev) =>
  createHash('sha256')
    .update(`${ev.sourceId}|${ev.uid}|${ev.allDay ? ev.startDate : ev.start.toISOString()}`)
    .digest('hex')
    .slice(0, 24);

/**
 * Decide which personal events should exist as blocks in the work calendar.
 * `days` are model days (with `work` windows) so 'workingHours' mode knows when
 * colleagues could book you.
 */
export function desiredBlocks({ events, days, config, now = new Date() }) {
  const s = syncSettings(config);
  const horizon = new Date(now.getTime() + s.lookaheadDays * 864e5);
  const windows = days.filter((d) => d.work).map((d) => ({ start: new Date(d.work.start), end: new Date(d.work.end) }));
  const statusRes = (config.statusRules || []).filter((r) => r.match).map((r) => ({ re: new RegExp(r.match, 'iu'), status: r.status }));
  const placeRe = config.placeRule ? new RegExp(config.placeRule, 'iu') : null;
  const buf = s.bufferMinutes * 60e3;
  const out = [];

  for (const ev of events) {
    if (!s.fromSources.includes(ev.sourceId)) continue;
    if (ev.transparent) continue;
    const text = `${ev.summary}\n${ev.description}`;
    if (s.skipTag && text.includes(s.skipTag)) continue;
    const tagged = s.blockTag && text.includes(s.blockTag);
    const cleanTitle = ev.summary.replace(/#\S+/g, '').replace(/\s{2,}/g, ' ').trim();

    if (ev.allDay) {
      if (!s.includeAllDay && !tagged) continue;
      // Status markers like "WFH" / "Travel to Tokyo" / "📍 Bali" aren't commitments.
      const st = statusRes.find((r) => r.re.test(cleanTitle));
      if (!tagged && ((st && config.statuses?.[st.status]?.working !== false) || placeRe?.test(cleanTitle))) continue;
      const endKey = ev.endDate;
      if (new Date(`${endKey}T00:00:00Z`) <= now || new Date(`${ev.startDate}T00:00:00Z`) >= horizon) continue;
      out.push({ key: keyOf(ev), allDay: true, startDate: ev.startDate, endDate: endKey || addDays(ev.startDate, 1), summary: summaryFor(s, cleanTitle) });
      continue;
    }

    const start = new Date(ev.start.getTime() - buf);
    const end = new Date(ev.end.getTime() + buf);
    if (end <= now || start >= horizon) continue;
    if (!tagged) {
      if (s.mode === 'tagged') continue;
      if (s.mode === 'workingHours' && !windows.some((w) => start < w.end && end > w.start)) continue;
    }
    out.push({ key: keyOf(ev), allDay: false, start: start.toISOString(), end: end.toISOString(), summary: summaryFor(s, cleanTitle) });
  }
  // A recurring event and its override can collide on key; keep the first.
  return [...new Map(out.map((b) => [b.key, b])).values()];
}

function summaryFor(s, title) {
  return s.copyTitle && title ? `${title}` : s.title;
}

function toGoogle(block, s) {
  const when = block.allDay
    ? { start: { date: block.startDate }, end: { date: block.endDate } }
    : { start: { dateTime: block.start }, end: { dateTime: block.end } };
  return {
    summary: block.summary,
    description: 'Blocked automatically from my personal calendar. Edit the original there; changes here will be overwritten.',
    ...when,
    visibility: 'private',
    transparency: 'opaque',
    ...(s.colorId ? { colorId: String(s.colorId) } : {}),
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { [SYNC_MARKER]: '1', pcKey: block.key } },
  };
}

function sameTiming(g, b) {
  if (b.allDay) return g.start?.date === b.startDate && g.end?.date === b.endDate;
  return g.start?.dateTime && new Date(g.start.dateTime).getTime() === new Date(b.start).getTime() && new Date(g.end.dateTime).getTime() === new Date(b.end).getTime();
}

/** Compute inserts / updates / deletes between desired blocks and what's in the calendar. */
export function planSync(desired, existing) {
  const byKey = new Map();
  const deletes = [];
  for (const g of existing) {
    const k = g.extendedProperties?.private?.pcKey;
    if (!k || byKey.has(k)) deletes.push(g.id); // orphan or duplicate
    else byKey.set(k, g);
  }
  const inserts = [];
  const updates = [];
  for (const b of desired) {
    const g = byKey.get(b.key);
    if (!g) inserts.push(b);
    else {
      if (!sameTiming(g, b) || g.summary !== b.summary) updates.push({ id: g.id, block: b });
      byKey.delete(b.key);
    }
  }
  for (const g of byKey.values()) deletes.push(g.id);
  return { inserts, updates, deletes };
}

export async function runSyncBack({ client, desired, config, now = new Date(), dryRun = false, log = console.log }) {
  const s = syncSettings(config);
  const timeMin = now;
  const timeMax = new Date(now.getTime() + s.lookaheadDays * 864e5);
  const existing = await client.listSynced({ timeMin, timeMax });
  const plan = planSync(desired, existing);
  log(`[sync-back] ${desired.length} personal blocks wanted · ${existing.length} already in work calendar → +${plan.inserts.length} new, ~${plan.updates.length} changed, -${plan.deletes.length} removed${dryRun ? ' (dry run, nothing written)' : ''}`);
  if (dryRun) return plan;
  for (const b of plan.inserts) await client.insert(toGoogle(b, s));
  for (const u of plan.updates) await client.patch(u.id, toGoogle(u.block, s));
  for (const id of plan.deletes) await client.remove(id);
  return plan;
}

/**
 * The work calendar feed will contain the blocks we created. Drop them when
 * building the public page so personal events don't also show as work "Busy".
 */
export function dropMirroredBlocks(events, config) {
  const s = syncSettings(config);
  if (!s.enabled) return events;
  const buf = s.bufferMinutes * 60e3;
  const personal = new Set(
    events
      .filter((e) => s.fromSources.includes(e.sourceId) && !e.allDay)
      .map((e) => `${e.start.getTime() - buf}|${e.end.getTime() + buf}`),
  );
  return events.filter((e) => {
    if (s.fromSources.includes(e.sourceId)) return true;
    if (!s.copyTitle && e.summary === s.title) return false;
    if (!e.allDay && personal.has(`${e.start.getTime()}|${e.end.getTime()}`)) return false;
    return true;
  });
}
