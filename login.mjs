// One-time Ring sign-in. You type your Ring email, password and the code Ring sends you into this
// small page yourself. Your password goes only to Ring and is never saved: only the refresh token
// Ring hands back is kept, in data/ring-token.json (readable by you only). The page lives at a random
// one-time address and the server stops as soon as the sign-in works.
//   node login.mjs           page on this computer only (127.0.0.1)
//   node login.mjs --lan     page on your home Wi-Fi too, to sign in from your phone at home
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { RingRestClient } from 'ring-client-api/rest-client';
import { saveToken } from './config.mjs';

const PORT = Number(process.env.PORT || 5420);
const LAN = process.argv.includes('--lan');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const KEY = crypto.randomBytes(9).toString('base64url');
let client = null;

const page = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ring sign-in</title><style>body{font:17px -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#faf7f2;max-width:420px;margin:0 auto;padding:32px 16px}
input{width:100%;box-sizing:border-box;font:inherit;padding:14px;margin:6px 0 14px;border-radius:12px;border:1px solid #333;background:#151618;color:inherit}
button{width:100%;font:600 17px inherit;padding:15px;border:0;border-radius:14px;background:#10c0df;color:#0a0a0a}p{color:#bbb}</style>${body}`;

const form = (msg = '') => page(`<h2>Ring sign-in</h2><p>For agentic-doorbell on your computer. Your password is only passed to Ring and never saved.</p>
<p style="color:#d9714b">${msg}</p><form method="post" action="/${KEY}/login">
<label>Ring email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button>Sign in</button></form>`);

const codeForm = (msg) => page(`<h2>Ring code</h2><p>${msg}</p><form method="post" action="/${KEY}/code">
<label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Send code</button></form>`);

const done = (res) => {
  res.end(page('<h2>Signed in</h2><p>agentic-doorbell can see your doorbell now. You can close this page.</p>'));
  console.log('Signed in. Token saved to data/ring-token.json');
  setTimeout(() => process.exit(0), 500);
};

http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!req.url.startsWith(`/${KEY}`)) { res.statusCode = 404; return res.end('not here'); }
  if (req.method === 'GET') return res.end(form());
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const f = Object.fromEntries(new URLSearchParams(raw));
  try {
    if (req.url.endsWith('/login')) {
      client = new RingRestClient({ email: f.email, password: f.password, controlCenterDisplayName: 'agentic-doorbell' });
      try {
        const auth = await client.getCurrentAuth();
        saveToken(auth.refresh_token);
        return done(res);
      } catch (e) {
        if (client.promptFor2fa) return res.end(codeForm(client.promptFor2fa));
        return res.end(form('Ring did not accept that email and password. Try again.'));
      }
    }
    if (req.url.endsWith('/code') && client) {
      try {
        const auth = await client.getAuth(f.code.trim());
        saveToken(auth.refresh_token);
        return done(res);
      } catch (e) {
        return res.end(codeForm('That code did not work. Check the latest one Ring sent and try again.'));
      }
    }
    res.end(form());
  } catch (e) {
    res.end(form('Something went wrong talking to Ring. Try again in a minute.'));
  }
}).listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`Open this page and sign in:\n  http://127.0.0.1:${PORT}/${KEY}`);
  if (LAN && lan) console.log(`From your phone on the same Wi-Fi:\n  http://${lan}:${PORT}/${KEY}`);
  console.log('It stops by itself once you are signed in (Ctrl+C to cancel).');
});
