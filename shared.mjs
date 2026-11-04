// The parts every doorbell brand shares: settings, the greetings, the face matcher, film mode.
// greeter.mjs (Ring) and eufy.mjs (Eufy) each add only what talks to their doorbell.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { HERE, DATA, LINES, FILM, FILM_FLAG, loadConfig } from './config.mjs';

export const run = promisify(execFile);
export const cfg = loadConfig();

export const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// A person's greeting: any sound file in data/lines/<name>/ (one is picked at random if there are
// several). Anyone it does not know gets data/lines/_stranger/.
export function lineFor(name) {
  for (const who of [name, '_stranger']) {
    const dir = who && path.join(LINES, who);
    if (dir && fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f));
      if (files.length) return path.join(dir, pick(files));
    }
  }
  return null;
}

export async function seconds(file) {
  const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(stdout) || 4;
}

// match.py --serve stays running so the face model loads once. Starting a fresh Python process for
// every frame cost about 2.3 s each, which made a greeting take over 10 s. One path in, one JSON line out.
let matcher = null;
const waiting = [];
function startMatcher() {
  matcher = spawn(cfg.python, [path.join(HERE, 'match.py'), '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  matcher.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const next = waiting.shift();
      try { next?.resolve(JSON.parse(line)); } catch (e) { next?.reject(e); }
    }
  });
  matcher.stderr.on('data', (d) => log('match.py:', String(d).trim().slice(0, 200)));
  matcher.on('exit', (code) => {
    log('match.py stopped', code);
    while (waiting.length) waiting.shift().reject(new Error('matcher stopped'));
    matcher = null;
  });
}
export function matchFile(file) {
  if (!matcher) startMatcher();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('match timed out')), 20000);
    waiting.push({ resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    matcher.stdin.write(file + '\n');
  });
}

// Reads the newest frame from a file an ffmpeg keeps overwriting (two a second), matches each one
// and deletes it, until someone known shows, the time runs out or stop() says so.
export async function lookAtFrames(live, ms, stop = () => false) {
  const end = Date.now() + ms;
  let last = { name: null };
  while (Date.now() < end && !stop()) {
    await new Promise((r) => setTimeout(r, 500));
    if (!fs.existsSync(live)) continue;
    const snap = path.join(DATA, `snap-${Date.now()}.jpg`);
    fs.copyFileSync(live, snap);
    fs.chmodSync(snap, 0o600);
    try {
      last = await matchFile(snap);
    } catch { fs.rmSync(snap, { force: true }); continue; }   // a half-written frame: try the next
    if (last.name) return last;
  }
  return last;
}

// The frame writer only stops with the call, and can write one more frame a few seconds after the
// call is down, so sweep its frames twice.
export function cleanLive() {
  const sweep = () => { for (const f of fs.readdirSync(DATA)) if (/^live-\d+\.jpg$/.test(f)) fs.rmSync(path.join(DATA, f), { force: true }); };
  setTimeout(sweep, 2000);
  setTimeout(sweep, 15000);
}

// Film mode: for filming a video of the greeter. On while data/film-mode exists and was touched in
// the last 24 hours, so it cannot be left on by mistake. While it is on, EVERY live call is recorded
// and kept in film/, known face or not (a face in bright sun can go unmatched, and that take would be
// lost). Anyone else who comes to the door in that window is recorded too, so switch it off after.
// The people in filmPeople (or listed in the data/film-mode file, one per line) get their whole
// walk-up filmed: a motion recording keeps going until they press the button.
export function filmNames() {
  try {
    const st = fs.statSync(FILM_FLAG);
    if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) return null;
    const names = fs.readFileSync(FILM_FLAG, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    return names.length ? names : cfg.filmPeople;
  } catch { return null; }
}
export const filmsFollow = (rec, name) => rec && name && (rec.names.length === 0 || rec.names.includes(name));

export async function keepFilm(rec, force = false) {
  if (!rec) return;
  await new Promise((r) => setTimeout(r, 2500));   // ffmpeg finishes writing after the call stops
  if (!fs.existsSync(rec.raw)) return log('film: nothing was written');
  fs.mkdirSync(FILM, { recursive: true });
  const stamp = new Date(rec.t0).toISOString().slice(0, 19).replace(/:/g, '-');
  const out = path.join(FILM, `${stamp}-${(rec.who || (force ? 'test' : 'no-match')).replace(/\s+/g, '-')}.mp4`);
  try {
    await run(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', rec.raw, '-c', 'copy', '-movflags', '+faststart', out]);
    fs.rmSync(rec.raw, { force: true });
  } catch (e) {
    fs.renameSync(rec.raw, out.replace(/\.mp4$/, '.mkv'));   // keep the raw file rather than lose the take
    log('film: mp4 copy failed, kept the mkv:', e.message.slice(0, 120));
  }
  fs.writeFileSync(out.replace(/\.(mp4|mkv)$/, '.json'), JSON.stringify({
    who: rec.who, started: new Date(rec.t0).toISOString(), line: rec.line,
    lineStartsAtSeconds: rec.lineAt ? +((rec.lineAt - rec.t0) / 1000).toFixed(1) : null,
  }, null, 2));
  log('film: kept', path.basename(out));
}
