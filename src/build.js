#!/usr/bin/env node
// Fetches the private calendars, sanitizes them and writes a static site to dist/.
//
//   node src/build.js            # uses the *_ICS_URL environment variables
//   node src/build.js --sample   # uses fixtures/ (no secrets needed)

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIcsText, parseIcs } from './ics-reader.js';
import { buildModel } from './model.js';
import { writeIcs } from './ics-writer.js';
import { encryptJson } from './crypto.js';
import { addDays, dateKeyInZone, zonedTimeToUtc } from './time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const sample = args.has('--sample') || process.env.USE_SAMPLE_DATA === '1';
const outDir = path.join(root, process.env.OUT_DIR || 'dist');

await loadDotEnv();

const config = JSON.parse(await readFile(path.join(root, process.env.CALENDAR_CONFIG || 'calendar.config.json'), 'utf8'));
validateConfig(config);

const tz = config.owner.timezone;
const now = new Date();
const today = dateKeyInZone(now, tz);
// Fetch a day of slack either side so timezone edges are covered.
const from = zonedTimeToUtc(addDays(today, -(config.window?.pastDays ?? 7) - 1), '00:00', tz);
const to = zonedTimeToUtc(addDays(today, (config.window?.futureDays ?? 90) + 2), '00:00', tz);

const events = [];
let loaded = 0;
for (const src of config.sources) {
  const url = sample ? null : process.env[src.urlEnv];
  const file = sample && src.sampleFile ? path.join(root, src.sampleFile) : null;
  if (!url && !file) {
    console.warn(`[${src.id}] no ${src.urlEnv} set — skipping this source`);
    continue;
  }
  try {
    const ics = await loadIcsText({ url, file });
    const parsed = parseIcs(ics, { from, to, sourceId: src.id });
    events.push(...parsed);
    loaded++;
    console.log(`[${src.id}] ${parsed.length} event instances`);
  } catch (err) {
    // Never print the URL: it is a secret.
    console.error(`[${src.id}] failed to load: ${err.message}`);
    if (process.env.FAIL_ON_SOURCE_ERROR !== '0') process.exitCode = 1;
  }
}
if (loaded === 0) console.warn('No calendar sources loaded — the site will only show working hours and defaults.');

const model = buildModel({ config, events, today, now });

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(path.join(root, 'public'), outDir, { recursive: true });

// Personalise the page shell (link previews in Telegram/WhatsApp/iMessage use these).
const htmlEsc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const siteTitle = `${config.owner.name}’s schedule`;
const siteDesc = config.owner.tagline || `See when ${config.owner.name} is free, busy or travelling.`;
const indexPath = path.join(outDir, 'index.html');
await writeFile(indexPath, (await readFile(indexPath, 'utf8')).replaceAll('__TITLE__', htmlEsc(siteTitle)).replaceAll('__DESCRIPTION__', htmlEsc(siteDesc)));
await writeFile(
  path.join(outDir, 'manifest.webmanifest'),
  JSON.stringify({ name: siteTitle, short_name: config.owner.name, start_url: './', display: 'standalone', background_color: '#f6f7f9', theme_color: '#0f172a', icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }] }),
);

const passcode = process.env.CALENDAR_PASSCODE || '';
const feedToken = (process.env.FEED_TOKEN || '').replace(/[^A-Za-z0-9_-]/g, '');
const ics = writeIcs(model);
let feedPath = null;

if (passcode) {
  await writeFile(path.join(outDir, 'data.json'), JSON.stringify(await encryptJson({ ...model, feed: feedToken ? `feed-${feedToken}.ics` : null }, passcode)));
  if (feedToken) {
    feedPath = `feed-${feedToken}.ics`;
  } else {
    console.warn('CALENDAR_PASSCODE is set but FEED_TOKEN is not — skipping the subscribable .ics feed so it can\'t leak.');
  }
} else {
  feedPath = feedToken ? `feed-${feedToken}.ics` : 'calendar.ics';
  await writeFile(path.join(outDir, 'data.json'), JSON.stringify({ ...model, feed: feedPath }));
}
if (feedPath) await writeFile(path.join(outDir, feedPath), ics);
await writeFile(path.join(outDir, '.nojekyll'), '');

console.log(
  `Built ${outDir} — ${model.days.length} days, ${model.events.length} events` +
    `${passcode ? ' (encrypted)' : ''}${feedPath ? `, feed: ${feedPath}` : ''}${sample ? ' [sample data]' : ''}`,
);

function validateConfig(c) {
  const problems = [];
  if (!c.owner?.timezone) problems.push('owner.timezone is required');
  else {
    try {
      new Intl.DateTimeFormat('en', { timeZone: c.owner.timezone });
    } catch {
      problems.push(`owner.timezone "${c.owner.timezone}" is not a valid IANA timezone`);
    }
  }
  if (!c.statuses || !Object.keys(c.statuses).length) problems.push('statuses must define at least one status');
  for (const [d, s] of Object.entries(c.defaultLocation || {})) {
    if (!c.statuses?.[s]) problems.push(`defaultLocation.${d} refers to unknown status "${s}"`);
  }
  for (const r of c.statusRules || []) {
    if (!c.statuses?.[r.status]) problems.push(`statusRules entry refers to unknown status "${r.status}"`);
    if (r.match) {
      try {
        new RegExp(r.match, 'iu');
      } catch (e) {
        problems.push(`invalid statusRules regex ${r.match}: ${e.message}`);
      }
    }
  }
  for (const [d, h] of Object.entries(c.workingHours?.days || {})) {
    if (!Array.isArray(h) || h.length !== 2 || !h.every((x) => /^\d{2}:\d{2}$/.test(x)) || h[0] >= h[1]) {
      problems.push(`workingHours.days.${d} must be ["HH:MM", "HH:MM"] with start before end`);
    }
  }
  for (const [k, v] of Object.entries(c.places || {})) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
    } catch {
      problems.push(`places.${k}: "${v}" is not a valid IANA timezone`);
    }
  }
  if (c.placeRule) {
    try {
      new RegExp(c.placeRule, 'iu');
    } catch (e) {
      problems.push(`invalid placeRule regex: ${e.message}`);
    }
  }
  for (const s of c.sources || []) {
    if (!['busy', 'titles', 'details'].includes(s.visibility)) problems.push(`source ${s.id}: visibility must be busy | titles | details`);
  }
  if (problems.length) {
    console.error('calendar.config.json has problems:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
}

async function loadDotEnv() {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
