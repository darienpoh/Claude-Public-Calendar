// Optional passcode protection. The data file is encrypted with AES-GCM using
// a key derived from the passcode (PBKDF2-SHA256), so a static host can serve
// it without anyone being able to read it unless they know the passcode.
// public/app.js contains the matching decrypt routine.

const ITERATIONS = 310_000;
const { subtle } = globalThis.crypto;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(passcode, salt, iterations) {
  const material = await subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJson(obj, passcode) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passcode, salt, ITERATIONS);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { encrypted: true, alg: 'PBKDF2-SHA256/AES-256-GCM', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(ct) };
}

export async function decryptJson(payload, passcode) {
  const key = await deriveKey(passcode, unb64(payload.salt), payload.iterations);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(payload.iv) }, key, unb64(payload.data));
  return JSON.parse(new TextDecoder().decode(pt));
}
