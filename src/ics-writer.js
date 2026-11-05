// Writes the sanitized model as an iCalendar feed friends can subscribe to.

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function utcStamp(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function dateStamp(key) {
  return key.replace(/-/g, '');
}

/** Fold lines to 75 octets per RFC 5545. */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (curLen + len > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

export function writeIcs(model, { domain = 'public-calendar' } = {}) {
  const stamp = utcStamp(model.generatedAt);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//public-calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${model.owner.name}'s schedule`)}`,
    `X-WR-TIMEZONE:${model.owner.timezone}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  const vevent = (uid, props) => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@${domain}`, `DTSTAMP:${stamp}`, ...props, 'END:VEVENT');
  };

  for (const day of model.days) {
    const s = day.status ? model.statuses[day.status] : null;
    if (s) {
      const title = `${s.emoji ? `${s.emoji} ` : ''}${s.label}${day.detail ? ` · ${day.detail}` : ''}`;
      vevent(`status-${day.date}`, [
        `DTSTART;VALUE=DATE:${dateStamp(day.date)}`,
        `SUMMARY:${esc(title)}`,
        'TRANSP:TRANSPARENT',
      ]);
    }
    if (day.work) {
      vevent(`work-${day.date}`, [
        `DTSTART:${utcStamp(day.work.start)}`,
        `DTEND:${utcStamp(day.work.end)}`,
        `SUMMARY:${esc(`${model.workingLabel}${s ? ` (${s.short})` : ''}`)}`,
        'TRANSP:OPAQUE',
      ]);
    }
  }

  for (const e of model.events) {
    const props = e.allDay
      ? [`DTSTART;VALUE=DATE:${dateStamp(e.startDate)}`, `DTEND;VALUE=DATE:${dateStamp(e.endDate)}`]
      : [`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end)}`];
    props.push(`SUMMARY:${esc(e.title)}`);
    if (e.location) props.push(`LOCATION:${esc(e.location)}`);
    props.push(`TRANSP:${e.free ? 'TRANSPARENT' : 'OPAQUE'}`);
    const key = e.allDay ? e.startDate : e.start;
    vevent(`${e.kind}-${utcStamp(key.length === 10 ? `${key}T00:00:00Z` : key)}-${e.id}`, props);
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
