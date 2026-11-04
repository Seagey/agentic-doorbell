// One-time Eufy sign-in, for "brand": "eufy". You type the email and password of the second Eufy
// account (README "Eufy") into this small page yourself, plus the code Eufy emails you or the
// picture check if it asks. Unlike Ring, Eufy's library needs the password every time it starts, so
// it is saved in data/eufy-login.json (readable by you only). The page lives at a random one-time
// address and the server stops as soon as the sign-in works.
//   node eufy-login.mjs           page on this computer only (127.0.0.1)
//   node eufy-login.mjs --lan     page on your home Wi-Fi too, to sign in from your phone at home
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { saveEufyLogin } from './config.mjs';
import { createEufy, attempt, findDoorbell } from './eufy-client.mjs';
import { cfg } from './shared.mjs';

const PORT = Number(process.env.PORT || 5420);
const LAN = process.argv.includes('--lan');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const KEY = crypto.randomBytes(9).toString('base64url');
let eufy = null, login = null, captchaId = null;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const page = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eufy sign-in</title><style>body{font:17px -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#faf7f2;max-width:420px;margin:0 auto;padding:32px 16px}
input{width:100%;box-sizing:border-box;font:inherit;padding:14px;margin:6px 0 14px;border-radius:12px;border:1px solid #333;background:#151618;color:inherit}
button{width:100%;font:600 17px inherit;padding:15px;border:0;border-radius:14px;background:#10c0df;color:#0a0a0a}p{color:#bbb}img{width:100%;border-radius:12px;background:#fff}</style>${body}`;

const form = (msg = '') => page(`<h2>Eufy sign-in</h2><p>For agentic-doorbell on your computer. Use the second Eufy account
your doorbell is shared with, not your main one. The password is saved on this computer only, because Eufy asks for it every time
the greeter starts.</p><p style="color:#d9714b">${esc(msg)}</p><form method="post" action="/${KEY}/login">
<label>Eufy email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<label>Country (two letters, e.g. AU, US, GB)<input name="country" value="US" maxlength="2" required></label>
<button>Sign in</button></form>`);

const codeForm = (msg) => page(`<h2>Eufy code</h2><p>${esc(msg)}</p><form method="post" action="/${KEY}/code">
<label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Send code</button></form>`);

const captchaForm = (image, msg = 'Eufy wants a picture check. Type the characters you see.') => page(`<h2>Picture check</h2><p>${esc(msg)}</p>
<img src="${esc(image.startsWith('data:') ? image : `data:image/png;base64,${image}`)}" alt="Eufy picture check">
<form method="post" action="/${KEY}/captcha"><label>Characters<input name="captcha" autocomplete="off" required></label><button>Send</button></form>`);

async function answer(res, r) {
  if (r.ok) {
    saveEufyLogin(login);
    const { bell } = await findDoorbell(eufy, cfg.camera, 30000);
    res.end(page(`<h2>Signed in</h2><p>${bell ? `agentic-doorbell can see <b>${esc(bell.getName())}</b> now.`
      : 'Signed in, but no doorbell showed up yet. Check the doorbell is shared with this account, with admin rights, then run node check.mjs.'}
      You can close this page.</p>`));
    console.log('Signed in. Saved to data/eufy-login.json');
    setTimeout(() => { eufy.close(); process.exit(0); }, 500);
    return;
  }
  if (r.tfa) return res.end(codeForm('Eufy emailed a code to this account. Type it here.'));
  if (r.captcha) { captchaId = r.captcha.id; return res.end(captchaForm(r.captcha.image)); }
  res.end(form(`Eufy did not accept that: ${r.error || 'unknown reason'}. Try again.`));
}

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
      if (eufy) { try { eufy.close(); } catch {} }
      login = { email: f.email.trim(), password: f.password, country: (f.country || 'US').trim().toUpperCase() };
      eufy = await createEufy(login);
      return await answer(res, await attempt(eufy));
    }
    if (req.url.endsWith('/code') && eufy) return await answer(res, await attempt(eufy, { verifyCode: f.code.trim() }));
    if (req.url.endsWith('/captcha') && eufy) {
      return await answer(res, await attempt(eufy, { captcha: { captchaId, captchaCode: f.captcha.trim() } }));
    }
    res.end(form());
  } catch (e) {
    res.end(form('Something went wrong talking to Eufy. Try again in a minute.'));
  }
}).listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`Open this page and sign in:\n  http://127.0.0.1:${PORT}/${KEY}`);
  if (LAN && lan) console.log(`From your phone on the same Wi-Fi:\n  http://${lan}:${PORT}/${KEY}`);
  console.log('It stops by itself once you are signed in (Ctrl+C to cancel).');
});
