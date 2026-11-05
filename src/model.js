import { addDays, dateKeyInZone, dateRange, weekdayOf, zonedTimeToUtc } from './time.js';
import { resolveTimezone, stripTzTag } from './places.js';

/**
 * Turn raw (private) calendar events into the sanitized public model.
 * Nothing that leaves this function should contain details the owner
 * hasn't chosen to share.
 */
export function buildModel({ config, events, today, now = new Date() }) {
  const tz = config.owner.timezone;
  const startKey = addDays(today, -(config.window?.pastDays ?? 7));
  const endKey = addDays(today, config.window?.futureDays ?? 90);
  const days = dateRange(startKey, endKey);
  const sources = new Map(config.sources.map((s) => [s.id, s]));
  const privacy = {
    busyLabel: 'Busy',
    blockTag: config.syncBack?.blockTag ?? '#block',
    noBlockTag: config.syncBack?.skipTag ?? '#noblock',
    ...config.privacy,
  };
  const rules = (config.statusRules || []).map((r) => ({
    ...r,
    re: r.match ? new RegExp(r.match, 'iu') : null,
  }));

  const placeRe = config.placeRule ? new RegExp(config.placeRule, 'iu') : null;

  // 1. Working-hours windows per day (before status overrides).
  const workWindow = new Map();
  for (const d of days) {
    const hours = config.workingHours?.days?.[weekdayOf(d)];
    if (hours) {
      workWindow.set(d, {
        start: zonedTimeToUtc(d, hours[0], tz),
        end: zonedTimeToUtc(d, hours[1], tz),
      });
    }
  }

  // 2. Classify every event: visibility + status marker.
  const rangeStart = zonedTimeToUtc(startKey, '00:00', tz);
  const rangeEnd = zonedTimeToUtc(addDays(endKey, 1), '00:00', tz);
  const classified = [];
  for (const ev of events) {
    if (ev.allDay ? ev.endDate <= startKey || ev.startDate > endKey : ev.end <= rangeStart || ev.start >= rangeEnd) continue;
    const src = sources.get(ev.sourceId) || { visibility: 'busy' };
    const haystack = `${ev.summary}\n${ev.description}`;
    if (privacy.hideTag && haystack.includes(privacy.hideTag)) continue;

    let visibility = src.visibility || 'busy';
    if (privacy.publicTag && haystack.includes(privacy.publicTag)) {
      visibility = visibility === 'details' ? 'details' : 'titles';
    }
    if (
      ev.klass === 'PRIVATE' ||
      ev.klass === 'CONFIDENTIAL' ||
      (privacy.privateTag && haystack.includes(privacy.privateTag))
    ) {
      visibility = 'busy';
    }
    const title = stripTags(ev.summary, privacy);
    let marker = matchStatus(rules, title, ev);
    // "📍 Bali" style events move the owner's timezone without changing their status.
    if (!marker && placeRe) {
      const m = title.match(placeRe);
      if (m) marker = { status: null, detail: (m.groups?.detail || '').trim() };
    }
    classified.push({ ev, src, visibility, title, marker });
  }

  // 3. Resolve one location status per day.
  const candidates = new Map(); // dateKey -> [{status, detail}]
  const addCandidate = (d, c) => {
    if (!candidates.has(d)) candidates.set(d, []);
    candidates.get(d).push(c);
  };
  for (const c of classified) {
    if (!c.marker) continue;
    const { status } = c.marker;
    const statusCfg = status ? config.statuses[status] : { working: true };
    if (!statusCfg) continue;
    const detail = c.visibility === 'busy' ? '' : c.marker.detail || c.ev.location || '';
    // Where in the world is the owner? Travel destinations set that day's timezone.
    const tagged = [c.ev.summary, c.ev.description].filter((t) => t && t.includes('#tz:'));
    const placeTz = resolveTimezone([...tagged, c.marker.detail, c.title, c.ev.location], config.places);
    if (!status && !placeTz) continue;
    for (const d of coveredDays(c.ev, tz)) {
      if (!c.ev.allDay && statusCfg.working === false) {
        // A timed "off" block (e.g. afternoon leave) only flips the whole day
        // if it covers that day's working hours.
        const w = workWindow.get(d);
        if (!w || c.ev.start > w.start || c.ev.end < w.end) continue;
      }
      addCandidate(d, { status, detail, placeTz, placePublic: c.visibility !== 'busy', placeLabel: c.marker.detail });
    }
  }

  const dayOut = [];
  for (const d of days) {
    const all = candidates.get(d) || [];
    const list = all.filter((c) => c.status);
    list.sort((a, b) => (config.statuses[b.status].priority ?? 0) - (config.statuses[a.status].priority ?? 0));
    let status = list[0]?.status ?? config.defaultLocation?.[weekdayOf(d)] ?? null;
    if (status && !config.statuses[status]) status = null;
    const detail = list[0]?.detail || '';
    const statusCfg = status ? config.statuses[status] : null;
    const place = list.find((c) => c.placeTz) || all.find((c) => c.placeTz);
    const dayTz = place?.placeTz || tz;
    // Working hours follow the owner around: 9-6 in Tokyo while in Tokyo.
    const hours = config.workingHours?.days?.[weekdayOf(d)];
    let work = hours ? { start: zonedTimeToUtc(d, hours[0], dayTz), end: zonedTimeToUtc(d, hours[1], dayTz) } : null;
    if (statusCfg && statusCfg.working === false) work = null;
    if (work) workWindow.set(d, work);
    else workWindow.delete(d);
    dayOut.push({
      date: d,
      weekday: weekdayOf(d),
      status,
      detail: detail.slice(0, 80),
      tz: dayTz,
      // Name the city only when the event it came from is shareable.
      ...(dayTz !== tz && place?.placePublic ? { place: (place.placeLabel || cityName(dayTz)).slice(0, 40) } : {}),
      work: work ? { start: work.start.toISOString(), end: work.end.toISOString() } : null,
    });
  }

  // 4. Build public events.
  const busyTimed = [];
  const out = [];
  for (const c of classified) {
    const { ev, visibility, title, marker, src } = c;
    // All-day status markers are represented by the day badge instead.
    if (marker && ev.allDay) continue;

    if (visibility === 'busy') {
      if (ev.transparent) continue; // "free" events don't block time
      if (ev.allDay) {
        out.push({ kind: 'busy', title: privacy.busyLabel, allDay: true, startDate: ev.startDate, endDate: ev.endDate });
      } else {
        busyTimed.push({ start: ev.start, end: ev.end, merge: src.mergeBusy !== false });
      }
      continue;
    }

    const item = {
      kind: 'event',
      title: title || privacy.busyLabel,
      ...(visibility === 'details' && ev.location ? { location: ev.location.slice(0, 120) } : {}),
      ...(ev.transparent ? { free: true } : {}),
      ...(marker ? { status: marker.status } : {}),
    };
    if (ev.allDay) out.push({ ...item, allDay: true, startDate: ev.startDate, endDate: ev.endDate });
    else out.push({ ...item, allDay: false, start: ev.start.toISOString(), end: ev.end.toISOString() });
  }

  // Busy blocks: merge overlaps (hides meeting structure), then drop the
  // parts already covered by the working-hours block.
  const toMerge = busyTimed.filter((b) => b.merge);
  const noMerge = busyTimed.filter((b) => !b.merge);
  let busy = [...mergeIntervals(toMerge), ...noMerge];
  if (config.workingHours?.hideWorkEventsInsideHours) {
    const windows = [...workWindow.values()];
    busy = busy.flatMap((b) => subtractIntervals(b, windows));
  }
  for (const b of busy) {
    if (b.end - b.start < 60e3) continue;
    out.push({ kind: 'busy', title: privacy.busyLabel, allDay: false, start: b.start.toISOString(), end: b.end.toISOString() });
  }

  out.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  out.forEach((e, i) => (e.id = `e${i}`));

  return {
    version: 1,
    generatedAt: now.toISOString(),
    owner: {
      name: config.owner.name,
      timezone: tz,
      homeCity: config.owner.homeCity || cityName(tz),
      tagline: config.owner.tagline || '',
    },
    workingLabel: config.workingHours?.label || 'Working',
    statuses: Object.fromEntries(
      Object.entries(config.statuses).map(([k, v]) => [
        k,
        { label: v.label, short: v.short || v.label, emoji: v.emoji || '', color: v.color || '#64748b', working: v.working !== false },
      ]),
    ),
    range: { start: startKey, end: endKey },
    days: dayOut,
    events: out,
  };
}

function cityName(tz) {
  return tz.split('/').pop().replace(/_/g, ' ');
}

function stripTags(s, privacy) {
  let t = stripTzTag(s);
  for (const tag of [privacy.privateTag, privacy.publicTag, privacy.hideTag, privacy.blockTag, privacy.noBlockTag]) {
    if (tag) t = t.split(tag).join('');
  }
  return t.replace(/\s{2,}/g, ' ').trim();
}

function matchStatus(rules, title, ev) {
  for (const r of rules) {
    if (r.busyStatus && ev.busyStatus !== String(r.busyStatus).toUpperCase()) continue;
    if (r.re) {
      const m = title.match(r.re);
      if (!m) continue;
      return { status: r.status, detail: (m.groups?.detail || '').trim() };
    }
    if (r.busyStatus) return { status: r.status, detail: '' };
  }
  return null;
}

function coveredDays(ev, tz) {
  if (ev.allDay) return dateRange(ev.startDate, addDays(ev.endDate, -1));
  const first = dateKeyInZone(ev.start, tz);
  const last = dateKeyInZone(new Date(Math.max(ev.start.getTime(), ev.end.getTime() - 1)), tz);
  return dateRange(first, last);
}

export function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ start: new Date(iv.start), end: new Date(iv.end) });
    }
  }
  return out;
}

export function subtractIntervals(iv, holes) {
  let pieces = [{ start: iv.start, end: iv.end }];
  for (const h of holes) {
    if (h.end <= iv.start || h.start >= iv.end) continue;
    pieces = pieces.flatMap((p) => {
      if (h.end <= p.start || h.start >= p.end) return [p];
      const r = [];
      if (h.start > p.start) r.push({ start: p.start, end: h.start });
      if (h.end < p.end) r.push({ start: h.end, end: p.end });
      return r;
    });
  }
  return pieces;
}

function sortKey(e) {
  return e.allDay ? `${e.startDate}T00:00:00.000Z` : e.start;
}
