// Minimal Google Calendar API client (fetch only, no SDK).
// Auth: an OAuth refresh token for your own account, created once with
// `npm run google:auth`. Scope is limited to calendar events.

const API = 'https://www.googleapis.com/calendar/v3';
export const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const SYNC_MARKER = 'publicCalendarSync';

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = body.error === 'invalid_grant'
      ? ' (refresh token expired or revoked: run `npm run google:auth` again; if your OAuth app is in "Testing" mode, tokens expire after 7 days)'
      : '';
    throw new Error(`Google token refresh failed: ${body.error || res.status}${hint}`);
  }
  return body.access_token;
}

export function googleCalendar({ accessToken, calendarId = 'primary', fetchImpl = fetch }) {
  const base = `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
  async function call(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204 || (method === 'DELETE' && res.status === 410)) return null;
    const json = await res.json().catch(() => ({}));
    // Never include event content in errors: CI logs may be public.
    if (!res.ok) throw new Error(`Google Calendar ${method} failed: HTTP ${res.status} ${json.error?.status || ''}`.trim());
    return json;
  }

  return {
    /** Events this tool created, between timeMin and timeMax. */
    async listSynced({ timeMin, timeMax }) {
      const out = [];
      let pageToken;
      do {
        const q = new URLSearchParams({
          privateExtendedProperty: `${SYNC_MARKER}=1`,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: 'true',
          showDeleted: 'false',
          maxResults: '2500',
          ...(pageToken ? { pageToken } : {}),
        });
        const page = await call('GET', `${base}?${q}`);
        out.push(...(page.items || []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },
    insert: (ev) => call('POST', base, ev),
    patch: (id, ev) => call('PATCH', `${base}/${encodeURIComponent(id)}`, ev),
    remove: (id) => call('DELETE', `${base}/${encodeURIComponent(id)}`),
  };
}
