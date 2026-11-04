// Signing in to Eufy, shared by eufy-login.mjs (the one-time page) and eufy.mjs (the greeter).
// Uses eufy-security-client, a free library made by the community, not by Eufy.
import fs from 'node:fs';
import eufyLib from 'eufy-security-client';   // CommonJS: named imports do not all resolve
import { EUFY_STATE } from './config.mjs';

const { EufySecurity, P2PConnectionType, LogLevel } = eufyLib;

export async function createEufy({ email, password, country }) {
  fs.mkdirSync(EUFY_STATE, { recursive: true, mode: 0o700 });
  return EufySecurity.initialize({
    username: email,
    password,
    country: country || 'US',
    language: 'en',
    trustedDeviceName: 'agentic-doorbell',
    persistentDir: EUFY_STATE,              // the saved sign-in, so the code is only asked for once
    p2pConnectionSetup: P2PConnectionType.QUICKEST,
    pollingIntervalMinutes: 10,
    eventDurationSeconds: 10,
    acceptInvitations: true,                // takes the share invite from your main account
    logging: { level: LogLevel.Warn },
  });
}

// One sign-in attempt. Resolves with { ok }, { tfa } (Eufy emailed a code), { captcha: { id, image } }
// (image is a data URL) or { error }. Call it again on the same client with the code or captcha.
export function attempt(eufy, options = {}) {
  return new Promise((resolve) => {
    const done = (r) => { clearTimeout(t); off(); resolve(r); };
    const on = {
      connect: () => done({ ok: true }),
      'tfa request': () => done({ tfa: true }),
      'captcha request': (id, image) => done({ captcha: { id, image } }),
      'connection error': (e) => done({ error: e?.message || String(e) }),
    };
    const off = () => { for (const [k, f] of Object.entries(on)) eufy.removeListener(k, f); };
    for (const [k, f] of Object.entries(on)) eufy.on(k, f);
    const t = setTimeout(() => done({ error: 'Eufy did not answer in 60 seconds' }), 60000);
    eufy.connect({ force: false, ...options }).catch((e) => done({ error: e?.message || String(e) }));
  });
}

// After sign-in the library loads the account's devices in the background. Waits for a doorbell.
export async function findDoorbell(eufy, name, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const devices = await eufy.getDevices().catch(() => []);
    const bell = devices.find((d) => d.getName() === name) || devices.find((d) => d.isDoorbell());
    if (bell) return { bell, devices };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { bell: null, devices: await eufy.getDevices().catch(() => []) };
}
