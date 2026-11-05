import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ical from 'node-ical';
import { buildModel, mergeIntervals, subtractIntervals } from '../src/model.js';
import { parseIcs } from '../src/ics-reader.js';
import { writeIcs } from '../src/ics-writer.js';
import { encryptJson, decryptJson } from '../src/crypto.js';
import { zonedTimeToUtc, dateKeyInZone } from '../src/time.js';

const config = JSON.parse(readFileSync(new URL('../calendar.config.json', import.meta.url), 'utf8'));
const TZ = config.owner.timezone; // Europe/London
const TODAY = '2026-11-05'; // Thursday

const timed = (sourceId, summary, start, end, extra = {}) => ({
  sourceId, uid: summary, summary, description: '', location: '', klass: '', transparent: false, busyStatus: '',
  allDay: false, start: new Date(start), end: new Date(end), ...extra,
});
const allDay = (sourceId, summary, startDate, endDate, extra = {}) => ({
  sourceId, uid: summary, summary, description: '', location: '', klass: '', transparent: false, busyStatus: '',
  allDay: true, startDate, endDate, ...extra,
});
const build = (events) => buildModel({ config, events, today: TODAY, now: new Date('2026-11-05T12:00:00Z') });
const day = (m, d) => m.days.find((x) => x.date === d);

test('timezone conversion handles DST', () => {
  assert.equal(zonedTimeToUtc('2026-07-01', '09:00', 'Europe/London').toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(zonedTimeToUtc('2026-12-01', '09:00', 'Europe/London').toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(zonedTimeToUtc('2026-03-29', '09:00', 'America/New_York').toISOString(), '2026-03-29T13:00:00.000Z');
  assert.equal(dateKeyInZone(new Date('2026-11-05T23:30:00Z'), 'Asia/Singapore'), '2026-11-06');
});

test('work event titles never leak', () => {
  const m = build([timed('work', 'Acquisition of Contoso — CONFIDENTIAL', '2026-11-05T19:00:00Z', '2026-11-05T20:00:00Z', { location: 'Board room', description: 'secret' })]);
  const json = JSON.stringify(m);
  assert.ok(!json.includes('Contoso'));
  assert.ok(!json.includes('Board room'));
  assert.ok(!json.includes('secret'));
  const busy = m.events.filter((e) => e.kind === 'busy');
  assert.equal(busy.length, 1);
  assert.equal(busy[0].title, 'Busy');
});

test('overlapping work meetings are merged and hidden inside working hours', () => {
  const m = build([
    timed('work', 'A', '2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z'), // inside 9-18 → dropped
    timed('work', 'B', '2026-11-05T17:30:00Z', '2026-11-05T19:00:00Z'), // straddles end of day
    timed('work', 'C', '2026-11-05T18:30:00Z', '2026-11-05T19:30:00Z'), // overlaps B
  ]);
  const busy = m.events.filter((e) => e.kind === 'busy');
  assert.deepEqual(busy.map((b) => [b.start, b.end]), [['2026-11-05T18:00:00.000Z', '2026-11-05T19:30:00.000Z']]);
});

test('personal privacy: #private and CLASS:PRIVATE become Busy, #hide disappears', () => {
  const m = build([
    timed('personal', 'Therapy #private', '2026-11-07T10:00:00Z', '2026-11-07T11:00:00Z'),
    timed('personal', 'Doctor', '2026-11-07T12:00:00Z', '2026-11-07T13:00:00Z', { klass: 'PRIVATE' }),
    timed('personal', 'Surprise party #hide', '2026-11-07T14:00:00Z', '2026-11-07T15:00:00Z'),
    timed('personal', 'Dinner with Sam', '2026-11-07T19:00:00Z', '2026-11-07T21:00:00Z', { location: '12 Secret St' }),
  ]);
  const json = JSON.stringify(m);
  for (const s of ['Therapy', 'Doctor', 'Surprise', '12 Secret St']) assert.ok(!json.includes(s), s);
  assert.equal(m.events.filter((e) => e.kind === 'busy').length, 2);
  assert.ok(m.events.some((e) => e.title === 'Dinner with Sam'));
});

test('#public on a work event shows its title', () => {
  const m = build([timed('work', 'Team dinner #public', '2026-11-05T19:00:00Z', '2026-11-05T21:00:00Z')]);
  assert.equal(m.events[0].title, 'Team dinner');
});

test('default weekly location pattern and working hours', () => {
  const m = build([]);
  assert.equal(day(m, '2026-11-02').status, 'office'); // Mon
  assert.equal(day(m, '2026-11-03').status, 'wfh'); // Tue
  assert.equal(day(m, '2026-11-07').status, null); // Sat
  assert.equal(day(m, '2026-11-07').work, null);
  assert.deepEqual(day(m, '2026-11-06').work, { start: '2026-11-06T09:00:00.000Z', end: '2026-11-06T17:00:00.000Z' });
});

test('status markers override defaults; travel beats everything; detail respects visibility', () => {
  const m = build([
    allDay('personal', 'WFH', '2026-11-05', '2026-11-06'),
    allDay('personal', 'Travel to Lisbon', '2026-11-09', '2026-11-12'),
    allDay('personal', 'Office', '2026-11-10', '2026-11-11'),
    allDay('work', 'Trip: Client site Paris', '2026-11-16', '2026-11-17'),
  ]);
  assert.equal(day(m, '2026-11-05').status, 'wfh');
  for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) {
    assert.equal(day(m, d).status, 'travel');
    assert.equal(day(m, d).detail, 'Lisbon');
  }
  assert.equal(day(m, '2026-11-12').status, 'office'); // trip over → back to Thursday default
  assert.equal(day(m, '2026-11-16').status, 'travel');
  assert.equal(day(m, '2026-11-16').detail, ''); // work source is busy-only: no destination
  // All-day markers are not duplicated as events.
  assert.equal(m.events.length, 0);
});

test('Outlook OOF marks the day off and removes working hours', () => {
  const m = build([allDay('work', 'Annual leave', '2026-11-09', '2026-11-11', { busyStatus: 'OOF' })]);
  assert.equal(day(m, '2026-11-09').status, 'ooo');
  assert.equal(day(m, '2026-11-09').work, null);
  assert.equal(day(m, '2026-11-11').status, 'office');
});

test('a short timed "off" block does not flip the whole day', () => {
  const m = build([timed('work', 'OOO - dentist', '2026-11-05T13:00:00Z', '2026-11-05T15:00:00Z')]);
  assert.notEqual(day(m, '2026-11-05').status, 'ooo');
  assert.ok(day(m, '2026-11-05').work);
});

test('interval helpers', () => {
  const d = (h) => new Date(Date.UTC(2026, 0, 1, h));
  assert.deepEqual(mergeIntervals([{ start: d(1), end: d(3) }, { start: d(2), end: d(4) }, { start: d(5), end: d(6) }]).map((i) => [i.start.getUTCHours(), i.end.getUTCHours()]), [[1, 4], [5, 6]]);
  assert.deepEqual(subtractIntervals({ start: d(8), end: d(20) }, [{ start: d(9), end: d(18) }]).map((i) => [i.start.getUTCHours(), i.end.getUTCHours()]), [[8, 9], [18, 20]]);
});

test('sample fixtures parse, including Outlook Windows timezones and recurrence', () => {
  const from = new Date('2026-11-01T00:00:00Z');
  const to = new Date('2026-11-15T00:00:00Z');
  const work = parseIcs(readFileSync(new URL('../fixtures/work.ics', import.meta.url), 'utf8'), { from, to, sourceId: 'work' });
  const standups = work.filter((e) => e.summary.startsWith('Daily standup'));
  assert.equal(standups.length, 10);
  assert.equal(standups[0].start.toISOString(), '2026-11-02T09:30:00.000Z');
});

test('generated .ics feed is valid and sanitized', () => {
  const m = build([
    timed('work', 'Secret merger call', '2026-11-05T19:00:00Z', '2026-11-05T20:00:00Z'),
    timed('personal', 'Pub quiz, with friends; fun', '2026-11-06T19:00:00Z', '2026-11-06T21:00:00Z'),
  ]);
  const ics = writeIcs(m);
  assert.ok(!ics.includes('merger'));
  const parsed = Object.values(ical.sync.parseICS(ics)).filter((e) => e.type === 'VEVENT');
  assert.ok(parsed.some((e) => e.summary === 'Pub quiz, with friends; fun'));
  assert.ok(parsed.some((e) => e.summary === 'Busy'));
  assert.ok(parsed.some((e) => String(e.summary).includes('Working from home')));
});

test('encryption round-trips and rejects a wrong passcode', async () => {
  const payload = await encryptJson({ hello: 'world' }, 'correct horse');
  assert.ok(!JSON.stringify(payload).includes('world'));
  assert.deepEqual(await decryptJson(payload, 'correct horse'), { hello: 'world' });
  await assert.rejects(decryptJson(payload, 'wrong'));
});
