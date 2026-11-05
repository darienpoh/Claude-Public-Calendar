// Timezone helpers built on Intl only (no tz database dependency).

const partsFormatters = new Map();

function formatterFor(timeZone) {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(date, timeZone) {
  const out = {};
  for (const p of formatterFor(timeZone).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday.toLowerCase().slice(0, 3),
  };
}

/** Offset (ms) of timeZone from UTC at the given instant. */
function offsetAt(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in timeZone to a UTC Date. Handles DST transitions. */
export function zonedTimeToUtc(dateKey, hhmm, timeZone) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetAt(new Date(guess), timeZone);
  // Second pass corrects for an offset change between guess and result.
  ts = guess - offsetAt(new Date(ts), timeZone);
  return new Date(ts);
}

/** YYYY-MM-DD of an instant in a timezone. */
export function dateKeyInZone(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** YYYY-MM-DD from a Date's process-local fields (how node-ical represents all-day dates). */
export function localDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Inclusive list of date keys from start to end. */
export function dateRange(startKey, endKey) {
  const out = [];
  for (let k = startKey; k <= endKey; k = addDays(k, 1)) out.push(k);
  return out;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
