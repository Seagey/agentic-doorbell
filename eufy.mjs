// agentic-doorbell for a Eufy video doorbell. greeter.mjs starts this when config.json has
// "brand": "eufy", so every command in the README stays the same.
//
// Same idea as the Ring part: a press opens the live view, frames go to match.py (on this computer
// only), and that person's greeting plays through the doorbell's speaker (Eufy calls it talkback).
// Motion only looks. It talks to the doorbell through eufy-security-client, a free library made by
// the community, not by Eufy. Built against its source in November 2026 but NOT yet tested on a real
// Eufy doorbell: see README "Eufy" for what is known and what is not.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import eufyLib from 'eufy-security-client';
import { DATA, LINES, readEufyLogin } from './config.mjs';
import { cfg, log, run, lineFor, seconds, lookAtFrames, cleanLive, filmNames, filmsFollow, keepFilm } from './shared.mjs';
import { createEufy, attempt, findDoorbell } from './eufy-client.mjs';

const { VideoCodec } = eufyLib;

const login = readEufyLogin();
if (!login) {
  console.error('Not signed in to Eufy yet. Run: node eufy-login.mjs   (README "Eufy")');
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

const eufy = await createEufy(login);
const signedIn = await attempt(eufy);
if (!signedIn.ok) {
  console.error(signedIn.error ? `Eufy sign-in failed: ${signedIn.error}`
    : 'Eufy wants a code or a picture check. Run node eufy-login.mjs again, then start this again.');
  process.exit(1);
}
const { bell, devices } = await findDoorbell(eufy, cfg.camera);
if (!bell) {
  console.error(`No Eufy doorbell found (found: ${devices.map((d) => d.getName()).join(', ') || 'nothing'}). ` +
    'Check the doorbell is shared with this account, with admin rights.');
  eufy.close(); process.exit(1);
}
const SN = bell.getSerial();
log('watching', bell.getName(), `(Eufy ${bell.getModel()})`);
const stopAll = () => { try { eufy.close(); } catch {} process.exit(0); };
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

// Resolves with the first event of `name` that is about our doorbell, or rejects after ms.
function waitFor(name, ms, start) {
  return new Promise((resolve, reject) => {
    const on = (station, device, ...rest) => { if (device?.getSerial?.() === SN) { clearTimeout(t); eufy.removeListener(name, on); resolve(rest); } };
    const t = setTimeout(() => { eufy.removeListener(name, on); reject(new Error(`${name}: nothing in ${ms / 1000} s`)); }, ms);
    eufy.on(name, on);
    start().catch((e) => { clearTimeout(t); eufy.removeListener(name, on); reject(e); });
  });
}

// ---- the live view --------------------------------------------------------------------------
// One live view at a time, shared: motion opens it and a press a moment later keeps using it,
// because opening a Eufy live view again can take many seconds. The station hands over the raw
// video (H.264 or H.265); one ffmpeg turns it into two JPEG frames a second for the face check.
let live = null;

async function openLive() {
  if (live) return live;
  const [meta, video, audio] = await waitFor('station livestream start', 30000, () => eufy.startStationLivestream(SN));
  audio?.resume?.();   // the doorbell's sound is not used; drain it so it never backs up the stream
  const fmt = meta.videoCodec === VideoCodec.H265 ? 'hevc' : 'h264';
  const frames = path.join(DATA, `live-${Date.now()}.jpg`);
  const ff = spawn(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', fmt, '-i', 'pipe:0',
    '-vf', 'fps=2', '-q:v', '4', '-f', 'image2', '-update', '1', frames]);
  ff.stdin.on('error', () => {});   // ffmpeg gone first: nothing to do
  ff.stderr.on('data', (d) => log('ffmpeg:', String(d).trim().slice(0, 200)));
  video.pipe(ff.stdin);
  live = { meta, video, fmt, frames, ff, rec: null, at: Date.now() };
  live.rec = film(live);
  log('live view open', `${meta.videoWidth}x${meta.videoHeight} ${fmt}`);
  return live;
}

async function closeLive() {
  if (!live) return null;
  const l = live; live = null;
  l.video.unpipe();
  l.ff.stdin.end(); l.ff.kill('SIGTERM');
  if (l.rec) { l.rec.ff.stdin.end(); }
  await eufy.stopStationLivestream(SN).catch(() => {});
  fs.rmSync(l.frames, { force: true });
  cleanLive();
  return l.rec;
}

// Film mode (README): the live view's video, copied as it comes, into MKV so a killed ffmpeg still
// leaves a playable file. Video only: the doorbell's sound comes on a separate stream.
function film(l, force = false) {
  const names = filmNames();
  if (!names && !force) return null;
  const raw = path.join(DATA, `film-${Date.now()}.mkv`);
  const ff = spawn(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-use_wallclock_as_timestamps', '1',
    '-f', l.fmt, '-i', 'pipe:0', '-c', 'copy', '-f', 'matroska', raw]);
  ff.stdin.on('error', () => {});
  l.video.pipe(ff.stdin);
  log('film: recording');
  return { raw, ff, t0: Date.now(), names: names || [], who: null, line: null, lineAt: null };
}

// ---- the greeting -------------------------------------------------------------------------
// Talkback takes AAC in ADTS frames, one frame per write (format and the 20 kbps from thieren, who
// wrote the library's talkback: higher rates stuttered; one T8200 only played clean in stereo, hence
// eufyStereo). The greeting is rendered to 16 kHz AAC first (with the same quiet lead-in and tail as the Ring part), then each frame is written at
// real-time pace (1024 samples, 64 ms) so the doorbell never gets a burst. Returns { ok, why }.
async function speak(file, rec = null) {
  const [stream] = await waitFor('station talkback start', 15000, () => eufy.startStationTalkback(SN));
  let ended = false;
  const onStop = (station, device) => { if (device?.getSerial?.() === SN) ended = true; };
  eufy.on('station talkback stop', onStop);
  const ready = path.join(DATA, `say-${Date.now()}.aac`);
  try {
    await run(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anoisesrc=d=1.2:c=pink:r=16000:a=0.002', '-i', file, '-filter_complex',
      '[0]aformat=sample_rates=16000:channel_layouts=mono[n];[1]aresample=16000,aformat=sample_rates=16000:channel_layouts=mono[v];' +
      '[n][v]concat=n=2:v=0:a=1,apad=pad_dur=1.5',
      '-acodec', 'aac', '-profile:a', 'aac_low', '-ar', '16000', '-ac', cfg.eufyStereo ? '2' : '1', '-b:a', '20k', '-f', 'adts', ready]);
    const frames = adtsFrames(fs.readFileSync(ready));
    const length = await seconds(ready);
    if (rec) { rec.line = file; rec.lineAt = Date.now() + 1200; }
    const t0 = Date.now();
    let sent = 0;
    for (const [i, frame] of frames.entries()) {
      if (ended) break;
      const due = t0 + i * 64 - Date.now();
      if (due > 0) await new Promise((r) => setTimeout(r, due));
      stream.write(frame);
      sent++;
    }
    await new Promise((r) => setTimeout(r, 1500));
    const took = (Date.now() - t0) / 1000;
    const why = !frames.length ? 'no audio frames made'
      : ended ? 'talkback stopped while speaking'
      : sent < frames.length ? `only ${sent} of ${frames.length} frames`
      : took < length * 0.9 ? `sent too fast (${took.toFixed(1)} s for ${length.toFixed(1)} s)`
      : null;
    log('spoke', path.basename(path.dirname(file)), `${sent}/${frames.length} frames in ${took.toFixed(1)} s`, why ? `PROBLEM: ${why}` : 'ok');
    return { ok: !why, why };
  } finally {
    eufy.removeListener('station talkback stop', onStop);
    fs.rmSync(ready, { force: true });
    await eufy.stopStationTalkback(SN).catch(() => {});
  }
}

// Splits an ADTS file into its frames: each starts with the 0xFFF sync word and carries its own
// length in 13 bits of the header.
function adtsFrames(buf) {
  const out = [];
  for (let i = 0; i + 7 <= buf.length;) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
    const len = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    if (len < 7 || i + len > buf.length) break;
    out.push(buf.subarray(i, i + len));
    i += len;
  }
  return out;
}

// ---- commands -------------------------------------------------------------------------------
const test = process.argv.indexOf('--test');
if (test > -1) {
  const file = lineFor(process.argv[test + 1]);
  if (!file) { console.error('no greeting to play: make one first (README step 6)'); stopAll(); }
  await openLive();
  await speak(file);
  await closeLive();
  log('test played', path.relative(LINES, file));
  stopAll();
}

if (process.argv.includes('--film-test')) {
  const l = await openLive();
  const rec = l.rec || (l.rec = film(l, true));
  const found = await lookAtFrames(l.frames, 12000).catch(() => ({}));
  rec.who = found.name || null;
  await closeLive();
  await keepFilm(rec, true);
  stopAll();
}

// ---- watching -------------------------------------------------------------------------------
let busy = false;
let dingWaiting = false;   // a press always wins: motion stops looking and leaves the live view to it
let seen = null;           // { name, at }: who motion last saw at the door

async function onMotion() {
  if (busy) return;
  busy = true;
  const t0 = Date.now();
  let l = null;
  try {
    l = await openLive();
    const found = await lookAtFrames(l.frames, cfg.lookOnMotionSeconds * 1000, () => dingWaiting);
    if (found.name) seen = { name: found.name, at: Date.now() };
    if (l.rec && !l.rec.who) l.rec.who = found.name || null;
    // Film mode: keep the walk-up on camera until the press, up to 20 s more.
    if (filmsFollow(l.rec, found.name)) {
      const until = Date.now() + 20000;
      while (!dingWaiting && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    }
    log('motion:', found.name || 'no one known', `faces ${found.faces ?? '?'}`, `distance ${found.distance ?? '-'}`,
        `${((Date.now() - t0) / 1000).toFixed(1)} s`, dingWaiting ? '(button pressed, handing over)' : '');
  } catch (e) {
    log('motion look failed:', e.message);
  } finally {
    // A press waiting takes over the open live view; otherwise close it.
    if (!dingWaiting) { const rec = await closeLive(); keepFilm(rec).catch((e) => log('film:', e.message)); }
    busy = false;
  }
}

async function onPress() {
  if (busy) {
    dingWaiting = true;
    const until = Date.now() + 20000;
    while (busy && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    dingWaiting = false;
    if (busy) return log('ding: doorbell still busy after 20 s, skipped');
  }
  busy = true;
  const t0 = Date.now();
  try {
    const l = await openLive();
    let found, how;
    if (seen && Date.now() - seen.at < 90 * 1000) { found = { name: seen.name, faces: 1 }; how = 'seen on motion'; }
    else { found = await lookAtFrames(l.frames, cfg.lookOnPressSeconds * 1000); how = 'live look'; }
    seen = null;
    if (l.rec) l.rec.who = found.name || l.rec.who;
    const file = lineFor(found.name);
    log('ding:', found.name || 'someone new', `faces ${found.faces ?? '?'}`, `distance ${found.distance ?? '-'}`,
        `${((Date.now() - t0) / 1000).toFixed(1)} s`, how);
    // The checker: if the greeting did not all go out, say the whole thing again, once.
    for (let attempt = 1; file && attempt <= 2; attempt++) {
      const sent = await speak(file, l.rec).catch((e) => ({ ok: false, why: e.message }));
      if (sent.ok) break;
      if (attempt === 2) { log('ding: greeting still not clean after a retry:', sent.why); break; }
      log('ding: saying it again');
    }
  } catch (e) {
    log('greeting failed:', e.message);
  } finally {
    const rec = await closeLive();
    keepFilm(rec).catch((e) => log('film:', e.message));
    busy = false;
  }
}

eufy.on('device rings', (device, state) => { if (state && device.getSerial() === SN) { log('push: ring'); onPress(); } });
const motion = (device, state) => { if (state && device.getSerial() === SN) { log('push: motion'); if (cfg.motion) onMotion(); } };
eufy.on('device motion detected', motion);
eufy.on('device person detected', motion);
