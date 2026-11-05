import ical from 'node-ical';
import { readFile } from 'node:fs/promises';
import { localDateKey, addDays } from './time.js';

/** Load raw ICS text from a URL (webcal:// supported) or a local file. */
export async function loadIcsText({ url, file }) {
  if (url) {
    const res = await fetch(url.replace(/^webcal:\/\//i, 'https://'), {
      headers: { 'User-Agent': 'public-calendar-sync/1.0', Accept: 'text/calendar, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching calendar`);
    return res.text();
  }
  return readFile(file, 'utf8');
}

function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'val' in v) return String(v.val ?? '');
  return String(v);
}

/**
 * Parse ICS text into flat event instances within [from, to].
 * Timed events carry Date `start`/`end`; all-day events carry YYYY-MM-DD
 * `startDate` (inclusive) / `endDate` (exclusive).
 */
export function parseIcs(icsText, { from, to, sourceId }) {
  const data = ical.sync.parseICS(icsText);
  const out = [];

  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== 'VEVENT') continue;
    // Overrides are attached to their parent via ev.recurrences; skip standalone copies.
    if (ev.recurrenceid && !ev.rrule) continue;
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;

    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    } catch (err) {
      console.warn(`[${sourceId}] skipping unparseable event "${text(ev.summary)}": ${err.message}`);
      continue;
    }

    for (const inst of instances) {
      const e = inst.event || ev;
      if (String(e.status || '').toUpperCase() === 'CANCELLED') continue;
      const base = {
        sourceId,
        uid: `${text(e.uid) || text(ev.uid)}`,
        summary: text(e.summary).trim(),
        description: text(e.description),
        location: text(e.location).trim(),
        klass: String(e.class || '').toUpperCase(),
        transparent: String(e.transparency || '').toUpperCase() === 'TRANSPARENT',
        busyStatus: String(
          e['MICROSOFT-CDO-BUSYSTATUS'] || e['X-MICROSOFT-CDO-BUSYSTATUS'] || '',
        ).toUpperCase(),
        allDay: Boolean(inst.isFullDay),
      };
      if (base.allDay) {
        const startDate = localDateKey(inst.start);
        let endDate = inst.end ? localDateKey(inst.end) : addDays(startDate, 1);
        if (endDate <= startDate) endDate = addDays(startDate, 1);
        out.push({ ...base, startDate, endDate });
      } else {
        const start = new Date(inst.start);
        const end = inst.end ? new Date(inst.end) : new Date(start.getTime() + 30 * 60e3);
        if (end <= from || start >= to) continue;
        out.push({ ...base, start, end });
      }
    }
  }
  return out;
}
