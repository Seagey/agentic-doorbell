// Checks the setup and says what to fix. Changes nothing.
//   node check.mjs            everything, including a read-only look at your Ring account
//   node check.mjs --offline  only this computer (no Ring sign-in needed)
// The Ring part uses the same sign-in as the greeter, so stop the greeter (if it is running) first:
// two programs using one Ring sign-in at the same time knock each other out.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HERE, FACES, LINES, loadConfig, readToken, saveToken, readEufyLogin } from './config.mjs';

const run = promisify(execFile);
const offline = process.argv.includes('--offline');
let fixes = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const fix = (msg) => { console.log(`  FIX  ${msg}`); fixes++; };
const note = (msg) => console.log(`  --   ${msg}`);

let cfg;
try { cfg = loadConfig(); } catch (e) { fix(e.message); process.exit(1); }

console.log('This computer');
const major = Number(process.versions.node.split('.')[0]);
major >= 22 ? ok(`Node ${process.versions.node}`) : fix(`Node ${process.versions.node}: needs 22 or newer`);

try {
  await run(cfg.ffmpeg, ['-version']);
  const { stdout } = await run(cfg.ffmpeg, ['-hide_banner', '-encoders']);
  /libopus/.test(stdout) ? ok('ffmpeg, with the Opus encoder') : fix('ffmpeg has no libopus encoder: install a full ffmpeg (brew install ffmpeg, or apt install ffmpeg)');
} catch { fix(`ffmpeg not found ("${cfg.ffmpeg}"): brew install ffmpeg (Mac) or sudo apt install ffmpeg (Linux)`); }
try { await run(cfg.ffprobe, ['-version']); ok('ffprobe'); } catch { fix('ffprobe not found (it comes with ffmpeg)'); }

if (!fs.existsSync(path.join(HERE, 'node_modules', cfg.brand === 'eufy' ? 'eufy-security-client' : 'ring-client-api'))) fix('Node packages missing: run ./setup.sh (or npm install)');
else ok('Node packages installed');

if (!fs.existsSync(cfg.python)) fix('No Python for face matching: run ./setup.sh');
else {
  try {
    await run(cfg.python, ['-c', 'import face_recognition'], { timeout: 60000 });
    ok('Python face matching (face_recognition) installed');
  } catch (e) { fix(`face_recognition will not load: ${String(e.stderr || e.message).trim().split('\n').pop()}. Run ./setup.sh again`); }
}

cfg.hasFile ? ok('config.json') : fix('No config.json: copy config.example.json to config.json');

console.log('People and greetings');
const people = fs.existsSync(FACES) ? fs.readdirSync(FACES).filter((n) => fs.statSync(path.join(FACES, n)).isDirectory()) : [];
if (!people.length) fix('No people yet: make a folder per person in data/faces/ (README step 4)');
for (const p of people) {
  const n = fs.readdirSync(path.join(FACES, p)).filter((f) => /\.(jpe?g|png)$/i.test(f)).length;
  const heic = fs.readdirSync(path.join(FACES, p)).filter((f) => /\.heic$/i.test(f)).length;
  n >= 5 ? ok(`${p}: ${n} photos`) : fix(`${p}: ${n} photos (5 to 15 works best)`);
  if (heic) fix(`${p}: ${heic} HEIC photos cannot be read: export them as JPEG`);
}
const index = path.join(HERE, 'data', 'faces.pkl');
if (people.length) {
  if (!fs.existsSync(index)) fix('No face index: run .venv/bin/python match.py --build (README step 5)');
  else {
    const built = fs.statSync(index).mtimeMs;
    const newer = people.some((p) => fs.readdirSync(path.join(FACES, p)).some((f) => fs.statSync(path.join(FACES, p, f)).mtimeMs > built));
    newer ? fix('Photos changed since the face index was built: run .venv/bin/python match.py --build') : ok('Face index is up to date');
  }
}
const hasSound = (name) => fs.existsSync(path.join(LINES, name)) &&
  fs.readdirSync(path.join(LINES, name)).some((f) => /\.(mp3|wav|m4a)$/i.test(f));
for (const p of people) hasSound(p) ? ok(`${p} has a greeting`) : note(`${p} has no greeting yet, so gets the stranger one (README step 6)`);
hasSound('_stranger') ? ok('Stranger greeting') : fix('No stranger greeting: add "_stranger" to lines.json and run node voice.mjs');

if (cfg.brand === 'eufy') {
  console.log('Eufy');
  major >= 24 ? ok('Node 24 or newer (the Eufy library needs it)') : fix(`Node ${process.versions.node}: the Eufy library needs Node 24 or newer`);
  const eufyLogin = readEufyLogin();
  if (!eufyLogin) fix('Not signed in to Eufy: run node eufy-login.mjs (README "Eufy")');
  else if (offline) note('Signed in (not checked: --offline)');
  else {
    const { createEufy, attempt, findDoorbell } = await import('./eufy-client.mjs');
    const eufy = await createEufy(eufyLogin);
    const r = await attempt(eufy);
    if (!r.ok) fix(r.error ? `Eufy said: ${r.error}` : 'Eufy wants a code or picture check: run node eufy-login.mjs again');
    else {
      const { bell, devices } = await findDoorbell(eufy, cfg.camera, 30000);
      for (const d of devices) console.log(`  ${d === bell ? 'ok  ' : '    '} ${d.getName()} | ${d.getModel()} | doorbell ${d.isDoorbell() ? 'yes' : 'no'}${d === bell ? '  <- the one it will use' : ''}`);
      if (!bell) fix('No Eufy doorbell on this account: share it from your main account with admin rights');
    }
    eufy.close();
  }
  console.log(fixes ? `\n${fixes} thing(s) to fix.` : '\nAll good.');
  process.exit(fixes ? 1 : 0);
}

console.log('Ring');
const token = readToken();
if (!token) fix('Not signed in to Ring: run node login.mjs (README step 3)');
else if (offline) note('Signed in (not checked: --offline)');
else {
  const { RingApi } = await import('ring-client-api');
  const ring = new RingApi({ refreshToken: token, controlCenterDisplayName: 'agentic-doorbell' });
  ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveToken(newRefreshToken));
  try {
    const cams = await ring.getCameras();
    for (const c of cams) {
      const mine = c.name === cfg.camera;
      console.log(`  ${mine ? 'ok  ' : '    '} ${c.name} | ${c.deviceType} | doorbell ${c.isDoorbot ? 'yes' : 'no'} | battery ${c.batteryLevel ?? 'wired'}${mine ? '  <- the one config.json uses' : ''}`);
    }
    if (!cams.some((c) => c.name === cfg.camera)) {
      const bell = cams.find((c) => c.isDoorbot);
      bell ? note(`No camera called "${cfg.camera}": it will use "${bell.name}". Set "camera" in config.json to be sure.`)
        : fix('No Ring doorbell on this account');
    }
  } catch (e) { fix(`Ring said: ${e.message}`); }
  ring.disconnect();
}

console.log(fixes ? `\n${fixes} thing(s) to fix.` : '\nAll good.');
process.exit(fixes ? 1 : 0);
