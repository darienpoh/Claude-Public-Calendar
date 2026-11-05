import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel } from '../src/model.js';
import { desiredBlocks, planSync, runSyncBack, dropMirroredBlocks } from '../src/sync-back.js';
import { googleCalendar } from '../src/google.js';

const base = JSON.parse(readFileSync(new URL('../calendar.config.json', import.meta.url), 'utf8'));
const config = {
  ...base,
  owner: { ...base.owner, timezone: 'Europe/London' },
  syncBack: { ...base.syncBack, enabled: true, bufferMinutes: 0 },
};
const NOW = new Date('2026-11-05T08:00:00Z'); // Thu
const ev = (summary, start, end, extra = {}) => ({
  sourceId: 'personal', uid: summary, summary, description: '', location: '', klass: '', transparent: false, busyStatus: '',
  allDay: false, start: new Date(start), end: new Date(end), ...extra,
});
const allDay = (summary, startDate, endDate, extra = {}) => ({
  sourceId: 'personal', uid: summary, summary, description: '', location: '', klass: '', transparent: false, busyStatus: '',
  allDay: true, startDate, endDate, ...extra,
});
const daysFor = (events, cfg = config) => buildModel({ config: cfg, events, today: '2026-11-05', now: NOW }).days;
const want = (events, cfg = config) => desiredBlocks({ events, days: daysFor(events, cfg), config: cfg, now: NOW });

test('workingHours mode blocks only personal events that clash with work hours', () => {
  const events = [
    ev('Dentist', '2026-11-05T13:00:00Z', '2026-11-05T14:00:00Z'), // inside 9-18 → block
    ev('Dinner', '2026-11-05T19:00:00Z', '2026-11-05T21:00:00Z'), // evening → no
    ev('School run #block', '2026-11-06T07:00:00Z', '2026-11-06T08:00:00Z'), // tagged → block anyway
    ev('Coffee #noblock', '2026-11-06T10:00:00Z', '2026-11-06T10:30:00Z'), // opted out
    ev('Yesterday', '2026-11-04T13:00:00Z', '2026-11-04T14:00:00Z'), // past → no
    ev('Optional', '2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z', { transparent: true }), // free → no
    { ...ev('Standup', '2026-11-05T10:00:00Z', '2026-11-05T10:15:00Z'), sourceId: 'work' }, // work → never
  ];
  const blocks = want(events);
  assert.deepEqual(blocks.map((b) => b.start), ['2026-11-05T13:00:00.000Z', '2026-11-06T07:00:00.000Z']);
  assert.ok(blocks.every((b) => b.summary === 'Personal commitment'));
});

test('titles are not copied unless copyTitle is on; tags are stripped', () => {
  const cfg = { ...config, syncBack: { ...config.syncBack, copyTitle: true } };
  const blocks = want([ev('Physio #block', '2026-11-06T13:00:00Z', '2026-11-06T14:00:00Z')], cfg);
  assert.equal(blocks[0].summary, 'Physio');
});

test('buffer pads blocks for travel time', () => {
  const cfg = { ...config, syncBack: { ...config.syncBack, bufferMinutes: 15 } };
  const [b] = want([ev('Dentist', '2026-11-05T13:00:00Z', '2026-11-05T14:00:00Z')], cfg);
  assert.equal(b.start, '2026-11-05T12:45:00.000Z');
  assert.equal(b.end, '2026-11-05T14:15:00.000Z');
});

test('all-day: status markers never block; holidays block when includeAllDay', () => {
  const cfg = { ...config, syncBack: { ...config.syncBack, includeAllDay: true } };
  const blocks = want([
    allDay('WFH', '2026-11-06', '2026-11-07'),
    allDay('Travel to Tokyo', '2026-11-09', '2026-11-11'),
    allDay('📍 Bali', '2026-11-12', '2026-11-13'),
    allDay('Holiday - Langkawi', '2026-11-16', '2026-11-18'),
    allDay("Mum's birthday lunch", '2026-11-19', '2026-11-20'),
  ], cfg);
  assert.deepEqual(blocks.map((b) => b.startDate), ['2026-11-16', '2026-11-19']);
  assert.equal(want([allDay('Holiday', '2026-11-16', '2026-11-18')]).length, 0); // off by default
});

test('planSync inserts, updates, deletes — and only touches its own events', () => {
  const desired = [
    { key: 'a', allDay: false, start: '2026-11-05T13:00:00.000Z', end: '2026-11-05T14:00:00.000Z', summary: 'Personal commitment' },
    { key: 'b', allDay: false, start: '2026-11-06T13:00:00.000Z', end: '2026-11-06T14:00:00.000Z', summary: 'Personal commitment' },
  ];
  const own = (id, key, start, end) => ({ id, summary: 'Personal commitment', start: { dateTime: start }, end: { dateTime: end }, extendedProperties: { private: { publicCalendarSync: '1', pcKey: key } } });
  const existing = [
    own('g1', 'a', '2026-11-05T13:00:00Z', '2026-11-05T14:00:00Z'), // unchanged
    own('g2', 'b', '2026-11-06T12:00:00Z', '2026-11-06T14:00:00Z'), // moved → update
    own('g3', 'c', '2026-11-07T12:00:00Z', '2026-11-07T13:00:00Z'), // cancelled → delete
  ];
  const plan = planSync(desired, existing);
  assert.equal(plan.inserts.length, 0);
  assert.deepEqual(plan.updates.map((u) => u.id), ['g2']);
  assert.deepEqual(plan.deletes, ['g3']);
});

test('runSyncBack writes private, reminder-free blocks via the Google API', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'GET') {
      assert.match(String(url), /privateExtendedProperty=publicCalendarSync%3D1/);
      return new Response(JSON.stringify({ items: [{ id: 'stale', extendedProperties: { private: { pcKey: 'gone' } } }] }), { status: 200 });
    }
    if (opts.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: 'new' }), { status: 200 });
  };
  const client = googleCalendar({ accessToken: 't', calendarId: 'me@work.com', fetchImpl: fakeFetch });
  const desired = want([ev('Dentist', '2026-11-05T13:00:00Z', '2026-11-05T14:00:00Z')]);
  const logs = [];
  await runSyncBack({ client, desired, config, now: NOW, log: (l) => logs.push(l) });

  const insert = calls.find((c) => c.method === 'POST');
  assert.ok(insert.url.includes(encodeURIComponent('me@work.com')));
  assert.equal(insert.body.visibility, 'private');
  assert.equal(insert.body.summary, 'Personal commitment');
  assert.deepEqual(insert.body.reminders, { useDefault: false, overrides: [] });
  assert.equal(insert.body.extendedProperties.private.publicCalendarSync, '1');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/stale')));
  assert.ok(!logs.join('\n').includes('Dentist'), 'logs must not leak personal titles');
});

test('dry run writes nothing', async () => {
  let writes = 0;
  const client = { listSynced: async () => [], insert: async () => writes++, patch: async () => writes++, remove: async () => writes++ };
  const plan = await runSyncBack({ client, desired: want([ev('Dentist', '2026-11-05T13:00:00Z', '2026-11-05T14:00:00Z')]), config, now: NOW, dryRun: true, log: () => {} });
  assert.equal(plan.inserts.length, 1);
  assert.equal(writes, 0);
});

test('mirrored blocks in the work feed are not double-counted on the public page', () => {
  const personal = ev('Dentist', '2026-11-05T13:00:00Z', '2026-11-05T14:00:00Z');
  const mirror = { ...ev('Personal commitment', '2026-11-05T13:00:00Z', '2026-11-05T14:00:00Z'), sourceId: 'work', uid: 'x' };
  const realMeeting = { ...ev('Board meeting', '2026-11-05T19:00:00Z', '2026-11-05T20:00:00Z'), sourceId: 'work', uid: 'y' };
  const kept = dropMirroredBlocks([personal, mirror, realMeeting], config);
  assert.deepEqual(kept.map((e) => e.summary), ['Dentist', 'Board meeting']);
});

test('#block tag is removed from public titles', () => {
  const m = buildModel({ config, events: [ev('School run #block', '2026-11-07T07:00:00Z', '2026-11-07T08:00:00Z')], today: '2026-11-05', now: NOW });
  assert.equal(m.events[0].title, 'School run');
});
