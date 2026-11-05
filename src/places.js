// Resolve a travel destination ("Tokyo", "SF", "Bali offsite") to an IANA timezone.
//
// Order of precedence:
//   1. An explicit tag anywhere in the event: "#tz:Asia/Tokyo"
//   2. config.places (your own aliases, e.g. { "the farm": "Pacific/Auckland" })
//   3. Built-in aliases for common cities / countries that aren't IANA zone names
//   4. Any IANA zone whose city part appears in the text (Tokyo → Asia/Tokyo)

const BUILTIN = {
  // North America
  'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles', 'bay area': 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', seattle: 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles', 'las vegas': 'America/Los_Angeles', portland: 'America/Los_Angeles',
  'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York',
  'washington': 'America/New_York', dc: 'America/New_York', miami: 'America/New_York', atlanta: 'America/New_York',
  austin: 'America/Chicago', dallas: 'America/Chicago', houston: 'America/Chicago', chicago: 'America/Chicago',
  denver: 'America/Denver', 'salt lake': 'America/Denver', toronto: 'America/Toronto', montreal: 'America/Toronto',
  vancouver: 'America/Vancouver', 'buenos aires': 'America/Argentina/Buenos_Aires', argentina: 'America/Argentina/Buenos_Aires',
  brazil: 'America/Sao_Paulo', 'rio': 'America/Sao_Paulo', 'mexico city': 'America/Mexico_City', hawaii: 'Pacific/Honolulu',
  // Europe
  london: 'Europe/London', uk: 'Europe/London', edinburgh: 'Europe/London', manchester: 'Europe/London',
  dublin: 'Europe/Dublin', ireland: 'Europe/Dublin', paris: 'Europe/Paris', france: 'Europe/Paris',
  berlin: 'Europe/Berlin', munich: 'Europe/Berlin', germany: 'Europe/Berlin', amsterdam: 'Europe/Amsterdam',
  barcelona: 'Europe/Madrid', spain: 'Europe/Madrid', milan: 'Europe/Rome', italy: 'Europe/Rome',
  zurich: 'Europe/Zurich', geneva: 'Europe/Zurich', switzerland: 'Europe/Zurich', portugal: 'Europe/Lisbon',
  greece: 'Europe/Athens', turkey: 'Europe/Istanbul',
  // Middle East / Africa
  dubai: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', uae: 'Asia/Dubai', doha: 'Asia/Qatar', qatar: 'Asia/Qatar',
  'tel aviv': 'Asia/Jerusalem', israel: 'Asia/Jerusalem', 'cape town': 'Africa/Johannesburg', 'south africa': 'Africa/Johannesburg',
  egypt: 'Africa/Cairo', kenya: 'Africa/Nairobi',
  // Asia
  singapore: 'Asia/Singapore', sg: 'Asia/Singapore', 'kuala lumpur': 'Asia/Kuala_Lumpur', kl: 'Asia/Kuala_Lumpur',
  malaysia: 'Asia/Kuala_Lumpur', penang: 'Asia/Kuala_Lumpur', 'johor bahru': 'Asia/Kuala_Lumpur', jb: 'Asia/Kuala_Lumpur',
  bali: 'Asia/Makassar', indonesia: 'Asia/Jakarta', jakarta: 'Asia/Jakarta', thailand: 'Asia/Bangkok',
  phuket: 'Asia/Bangkok', 'chiang mai': 'Asia/Bangkok', vietnam: 'Asia/Ho_Chi_Minh', hanoi: 'Asia/Bangkok',
  saigon: 'Asia/Ho_Chi_Minh', 'ho chi minh': 'Asia/Ho_Chi_Minh', philippines: 'Asia/Manila',
  'hong kong': 'Asia/Hong_Kong', hk: 'Asia/Hong_Kong', macau: 'Asia/Macau', taiwan: 'Asia/Taipei',
  china: 'Asia/Shanghai', beijing: 'Asia/Shanghai', shenzhen: 'Asia/Shanghai', guangzhou: 'Asia/Shanghai',
  japan: 'Asia/Tokyo', osaka: 'Asia/Tokyo', kyoto: 'Asia/Tokyo', korea: 'Asia/Seoul', busan: 'Asia/Seoul',
  india: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', bangalore: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata',
  'sri lanka': 'Asia/Colombo', nepal: 'Asia/Kathmandu', maldives: 'Indian/Maldives',
  // Oceania
  sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', brisbane: 'Australia/Brisbane', perth: 'Australia/Perth',
  adelaide: 'Australia/Adelaide', 'new zealand': 'Pacific/Auckland', nz: 'Pacific/Auckland',
  auckland: 'Pacific/Auckland', wellington: 'Pacific/Auckland', queenstown: 'Pacific/Auckland', christchurch: 'Pacific/Auckland',
};

let zoneCities = null;
function zoneCityIndex() {
  if (!zoneCities) {
    zoneCities = {};
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    for (const z of zones) {
      // Only Area/City zones; 3-part names include generic words like "Center".
      if (z.split('/').length !== 2 || /^(Etc|SystemV|US|Canada)\//.test(z)) continue;
      zoneCities[z.split('/').pop().replace(/_/g, ' ').toLowerCase()] = z;
    }
  }
  return zoneCities;
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const TZ_TAG = /#tz:([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2})/;
export const stripTzTag = (s) => String(s || '').replace(new RegExp(TZ_TAG.source, 'g'), '').replace(/\s{2,}/g, ' ').trim();

/** Returns an IANA zone or null. `texts` are searched in order (e.g. detail, title, location). */
export function resolveTimezone(texts, places = {}) {
  const all = texts.filter(Boolean).map(String);
  for (const t of all) {
    const m = t.match(TZ_TAG);
    if (m && isValidTimezone(m[1])) return m[1];
  }
  const user = Object.fromEntries(Object.entries(places).map(([k, v]) => [k.toLowerCase(), v]));
  const tables = [user, BUILTIN, zoneCityIndex()];
  for (const t of all) {
    const norm = ` ${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
    for (const table of tables) {
      // Longest names first so "new york" beats "york", "kuala lumpur" beats "kl".
      const keys = Object.keys(table).sort((a, b) => b.length - a.length);
      for (const k of keys) {
        if (norm.includes(` ${k} `) && isValidTimezone(table[k])) return table[k];
      }
    }
  }
  return null;
}
