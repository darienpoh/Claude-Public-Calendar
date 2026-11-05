#!/usr/bin/env node
// One-time helper: sign in with the Google account that owns your WORK calendar
// and print a refresh token to store as the GOOGLE_REFRESH_TOKEN secret.
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google:auth
//
// Run this on your own computer (it opens a browser sign-in and listens on localhost).

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { SCOPE } from '../src/google.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see README → "Sync-back").');
  process.exit(1);
}

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  if (url.searchParams.get('state') !== state) return res.writeHead(400).end('State mismatch');
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end(`Sign-in failed: ${url.searchParams.get('error') || 'no code'}`);
    return server.close();
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const body = await tokenRes.json();
  if (!body.refresh_token) {
    res.writeHead(500).end('No refresh token returned — see terminal.');
    console.error('Token exchange failed:', body.error || body);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>✅ Done — you can close this tab and go back to the terminal.</h2>');
    console.log('\nAdd this as the GitHub secret GOOGLE_REFRESH_TOKEN (keep it secret):\n');
    console.log(body.refresh_token + '\n');
  }
  server.close();
});

let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  console.log('Open this link and sign in with your WORK Google account:\n\n' + auth + '\n');
});
