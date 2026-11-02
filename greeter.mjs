// agentic-doorbell: greets the people you know, by name, through your Ring doorbell's own speaker.
//
// When someone presses the button it opens a live call straight away (a battery doorbell needs a few
// seconds to wake), reads frames from that call, asks match.py who it is (on this computer only, no
// cloud), and plays that person's greeting through the doorbell. Motion only looks, so a press a
// moment later can answer straight away. No AI model is called at ring time.
//
//   node greeter.mjs              run it (README step 9 keeps it running)
//   node greeter.mjs --test NAME  play NAME's greeting now, without anyone pressing the button
//   node greeter.mjs --film-test  record 12 s of the doorbell into film/ now (film mode, README)
//   node greeter.mjs --help       this text
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { RingApi, PushNotificationAction } from 'ring-client-api';
import { setFfmpegPath } from 'ring-client-api/ffmpeg';
import { filter, firstValueFrom, timeout } from 'rxjs';
import { RtpPacket } from 'werift';
import { HERE, DATA, LINES, FILM, FILM_FLAG, loadConfig, readToken, saveToken } from './config.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`agentic-doorbell

  node greeter.mjs              watch the doorbell and greet people (stop with Ctrl+C)
  node greeter.mjs --test NAME  play NAME's greeting through the doorbell now
  node greeter.mjs --film-test  record 12 seconds of the doorbell into film/

Only run one copy at a time. Stop the background service before --test or --film-test.`);
  process.exit(0);
}

const run = promisify(execFile);
const cfg = loadConfig();
setFfmpegPath(cfg.ffmpeg);

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// A person's greeting: any sound file in data/lines/<name>/ (one is picked at random if there are
// several). Anyone it does not know gets data/lines/_stranger/.
function lineFor(name) {
  for (const who of [name, '_stranger']) {
    const dir = who && path.join(LINES, who);
    if (dir && fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f));
      if (files.length) return path.join(dir, pick(files));
    }
  }
  return null;
}

async function seconds(file) {
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
function matchFile(file) {
  if (!matcher) startMatcher();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('match timed out')), 20000);
    waiting.push({ resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    matcher.stdin.write(file + '\n');
  });
}

// Ring's own snapshot is taken the moment motion starts, usually before anyone faces the door, and a
// battery doorbell cannot take one while a live call is streaming. So the greeter never uses Ring
// snapshots: it keeps looking through the live call, two frames a second, each matched and deleted
// (match.py), until someone known shows or the time runs out.
async function lookLive(call, ms, stop = () => false) {
  const live = path.join(DATA, `live-${Date.now()}.jpg`);
  // The library puts -vcodec copy and -acodec aac in front unless told otherwise, and a copied stream
  // cannot be filtered: ffmpeg quits with code 234 and takes the call down with it. So: no sound, and
  // frames encoded as JPEG. This ffmpeg runs until the call stops, so cleanLive() follows call.stop().
  await call.startTranscoding({ audio: ['-an'], video: ['-vcodec', 'mjpeg'],
    output: ['-vf', 'fps=2', '-q:v', '4', '-f', 'image2', '-update', '1', live] });
  const end = Date.now() + ms;
  let last = { name: null };
  try {
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
  } finally {
    fs.rmSync(live, { force: true });
  }
}

// The frame writer only stops with the call, and can write one more frame a few seconds after the
// call is down, so sweep its frames twice.
function cleanLive() {
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
function filmNames() {
  try {
    const st = fs.statSync(FILM_FLAG);
    if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) return null;
    const names = fs.readFileSync(FILM_FLAG, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    return names.length ? names : cfg.filmPeople;
  } catch { return null; }
}

// Video copied as it comes (the library's own recordToFile settings: a filtered copy is what quits
// with 234), sound to AAC, into MKV so a killed ffmpeg still leaves a playable file. The doorbell may
// cancel its own speaker out of its microphone, so the greeting, and when it started, go in a note
// beside the video for the edit.
function film(call, force = false) {
  const names = filmNames();
  if (!names && !force) return null;
  const raw = path.join(DATA, `film-${Date.now()}.mkv`);
  const rec = { raw, t0: Date.now(), names: names || [], who: null, line: null, lineAt: null };
  call.startTranscoding({ video: ['-vcodec', 'copy'], audio: ['-acodec', 'aac'], output: ['-f', 'matroska', raw] })
    .catch((e) => log('film: could not start:', e.message));
  log('film: recording');
  return rec;
}
const filmsFollow = (rec, name) => rec && name && (rec.names.length === 0 || rec.names.includes(name));

async function keepFilm(rec, force = false) {
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

// The doorbell's speaker needs a few seconds after it is switched on: a greeting sent 1 s after the
// switch lost its first two seconds. So the speaker is switched on as soon as the call opens (it
// warms up while we look), and the greeting never starts sooner than SPEAKER_MS after that.
const SPEAKER_MS = cfg.speakerWarmUpSeconds * 1000;

async function speak(call, file, speakerOn, rec = null) {
  // startLiveCall answers before the doorbell is really streaming. Sent straight away, only the tail
  // of the greeting comes out. So wait for the first video packet, and for the speaker to have been
  // on for SPEAKER_MS.
  await firstValueFrom(call.onVideoRtp.pipe(timeout(15000))).catch(() => log('no video yet, speaking anyway'));
  if (!speakerOn) { call.activateCameraSpeaker(); speakerOn = Date.now(); }
  const wait = speakerOn + SPEAKER_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  // Our own encode, not the library's transcodeReturnAudio: that one forces stereo 48 kHz, which came
  // out fast, buzzy and cut short on a Ring doorbell (the library's maintainer suspects doorbells
  // cannot handle it, dgreif/ring issue 984). The doorbell itself sends Opus in 60 ms packets, so we
  // send the same: mono, 16 kHz, 60 ms frames.
  if (rec) { rec.line = file; rec.lineAt = Date.now() + 1200; }   // after sendAudio's 1.2 s lead-in
  const sent = await sendAudio(call, file);  // returns once the whole greeting has gone out in real time
  await new Promise((r) => setTimeout(r, 1500));
  return sent;
}

// Sends the greeting and checks it all went: every packet ffmpeg made reached the call, at real-time
// pace, and the call was still up at the end. Returns { ok, why }.
async function sendAudio(call, file) {
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  const port = sock.address().port;
  let ended = false;
  const endSub = call.onCallEnded.subscribe(() => { ended = true; });
  let packets = 0, failed = 0;
  sock.on('message', (msg) => {
    try { call.sendAudioPacket(RtpPacket.deSerialize(msg)); packets++; } catch { failed++; }
  });
  // Pre-render the greeting with its lead-in and a tail, so -re paces every packet evenly. A lead-in
  // made by a filter went out as a burst, and the doorbell then dropped the end of the greeting.
  // The lead-in is 1.2 s of very quiet noise, not digital silence, so the doorbell's audio is already
  // flowing when the first word arrives.
  const ready = path.join(DATA, `say-${Date.now()}.wav`);
  await run(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anoisesrc=d=1.2:c=pink:r=16000:a=0.002', '-i', file, '-filter_complex',
    '[0]aformat=sample_rates=16000:channel_layouts=mono[n];[1]aresample=16000,aformat=sample_rates=16000:channel_layouts=mono[v];' +
    '[n][v]concat=n=2:v=0:a=1,apad=pad_dur=1.5', ready]);
  const length = await seconds(ready);
  const expected = Math.floor(length / 0.06);
  const t0 = Date.now();
  const ff = spawn(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-i', ready,
    '-acodec', 'libopus', '-ac', '1', '-ar', '16000',
    '-application', 'voip', '-frame_duration', '60', '-b:a', '24k', '-payload_type', '96',
    '-f', 'rtp', `rtp://127.0.0.1:${port}`]);
  ff.stderr.on('data', (d) => log('ffmpeg:', String(d).trim().slice(0, 200)));
  const code = await new Promise((r) => ff.on('close', r));
  await new Promise((r) => setTimeout(r, 300));   // the last packets are still in the socket
  const took = (Date.now() - t0) / 1000;
  endSub.unsubscribe();
  fs.rmSync(ready, { force: true });
  setTimeout(() => sock.close(), 1500);
  const why = code !== 0 ? `ffmpeg exit ${code}`
    : ended ? 'call ended while speaking'
    : failed ? `${failed} packets failed`
    : packets < expected * 0.95 ? `only ${packets} of ${expected} packets`
    : took < length * 0.9 ? `sent too fast (${took.toFixed(1)} s for ${length.toFixed(1)} s)`
    : null;
  log('spoke', path.basename(path.dirname(file)), `${packets}/${expected} packets in ${took.toFixed(1)} s`, why ? `PROBLEM: ${why}` : 'ok');
  return { ok: !why, why };
}

async function main() {
  const refreshToken = readToken();
  if (!refreshToken) {
    console.error('Not signed in to Ring yet. Run: node login.mjs   (README step 3)');
    process.exit(1);
  }
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const ring = new RingApi({ refreshToken, cameraStatusPollingSeconds: 20, controlCenterDisplayName: 'agentic-doorbell' });
  ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    saveToken(newRefreshToken);
    log('sign-in and push credentials saved');   // the token also carries the push keys
  });
  const cameras = await ring.getCameras();
  const camera = cameras.find((c) => c.name === cfg.camera) || cameras.find((c) => c.isDoorbot);
  if (!camera) throw new Error(`no doorbell called ${cfg.camera} (found: ${cameras.map((c) => c.name).join(', ') || 'none'})`);
  log('watching', camera.name, `(${camera.deviceType}, battery ${camera.batteryLevel ?? 'n/a'})`);

  const test = process.argv.indexOf('--test');
  if (test > -1) {
    const file = lineFor(process.argv[test + 1]);
    if (!file) throw new Error('no greeting to play: make one first (README step 6)');
    const call = await camera.startLiveCall();
    await speak(call, file);
    call.stop();
    log('test played', path.relative(LINES, file));
    process.exit(0);
  }

  if (process.argv.includes('--film-test')) {
    const call = await camera.startLiveCall();
    const rec = film(call, true);
    const found = await lookLive(call, 12000, () => false).catch(() => ({}));
    rec.who = found.name || null;
    call.stop(); cleanLive();
    await keepFilm(rec, true);
    process.exit(0);
  }

  // Every push Ring sends (motion and presses), so you can see pushes are arriving at all.
  camera.onNewNotification.subscribe((n) => log('push:', n?.android_config?.category || n?.action || 'event'));

  // A push that turns up more than a minute late (a slow network, or a redelivery after a restart) is
  // not someone at the door now, so it is logged and left alone.
  const stale = (n) => {
    const at = Date.parse(n?.data?.event?.ding?.created_at || '');
    return at && Date.now() - at > 60 * 1000;
  };

  let busy = false;
  let dingWaiting = false;   // a press always wins: motion stops looking and leaves the doorbell to it
  let seen = null;           // { name, at }: who motion last saw at the door
  let walkUp = null;         // film mode: motion's recording, waiting for the press to say who it was

  // Motion only looks, it never talks. It works out who is walking up, so a press a moment later can
  // answer straight away instead of looking then. Live camera only (see lookLive).
  if (cfg.motion) camera.onNewNotification.pipe(filter((n) => n?.android_config?.category === PushNotificationAction.Motion))
    .subscribe(async (n) => {
      if (busy) return;
      if (stale(n)) return log('motion: late push, skipped');
      busy = true;
      const t0 = Date.now();
      let call = null, rec = null;
      try {
        call = await camera.startLiveCall();
        rec = film(call);
        const found = await lookLive(call, cfg.lookOnMotionSeconds * 1000, () => dingWaiting);
        if (found.name) seen = { name: found.name, at: Date.now() };
        if (rec) rec.who = found.name || null;
        // Film mode: the look stops the moment it knows someone, mid walk-up. Keep filming until the
        // button is pressed, up to 20 s more, so the whole walk is on camera.
        if (filmsFollow(rec, found.name)) {
          const until = Date.now() + 20000;
          while (!dingWaiting && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
        }
        log('motion:', found.name || 'no one known', `faces ${found.faces ?? '?'}`, `distance ${found.distance ?? '-'}`,
            `${((Date.now() - t0) / 1000).toFixed(1)} s`, dingWaiting ? '(button pressed, handing over)' : '');
      } catch (e) {
        log('motion look failed:', e.message);
      } finally {
        if (call) { call.stop(); cleanLive(); }
        busy = false;
        // A press cut the look short before it knew anyone: the walk-up is on this recording, so it
        // is filed under the press's match.
        if (rec && !rec.who && dingWaiting) walkUp = rec;
        else keepFilm(rec).catch((e) => log('film:', e.message));
      }
    });

  camera.onDoorbellPressed.subscribe(async (ding) => {
    if (stale(ding)) return log('ding: late push, skipped');
    if (busy) {
      // Usually the walk-up motion, a second earlier. Ask it to stop and wait for the doorbell to be
      // free, up to 20 s, rather than dropping the press.
      dingWaiting = true;
      const until = Date.now() + 20000;
      while (busy && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      dingWaiting = false;
      if (busy) return log('ding: doorbell still busy after 20 s, skipped');
    }
    busy = true;
    const t0 = Date.now();
    const recs = [];
    try {
      let call = await camera.startLiveCall();
      recs.push(film(call));
      call.activateCameraSpeaker();                       // warms up while we look (see SPEAKER_MS)
      let speakerOn = Date.now();
      let found, how;
      if (seen && Date.now() - seen.at < 90 * 1000) {
        // Motion already saw who walked up: answer as soon as the doorbell is awake.
        found = { name: seen.name, faces: 1 }; how = 'seen on motion';
      } else {
        // Look on the live call before settling on the stranger greeting. Someone pressing is facing
        // the camera, but may be too close at first, so keep looking for a while.
        found = await lookLive(call, cfg.lookOnPressSeconds * 1000); how = 'live look';
      }
      seen = null;
      const file = lineFor(found.name);
      log('ding:', found.name || 'someone new', `faces ${found.faces ?? '?'}`, `distance ${found.distance ?? '-'}`,
          `${((Date.now() - t0) / 1000).toFixed(1)} s`, how);
      if (recs[0]) recs[0].who = found.name || null;
      if (walkUp) { walkUp.who = found.name || null; recs.push(walkUp); walkUp = null; }
      // The checker: if the greeting did not all go out (call dropped, packets lost, sent too fast),
      // say it again, once, on a fresh call if this one is gone. The whole message, every time.
      for (let attempt = 1; file && attempt <= 2; attempt++) {
        const sent = await speak(call, file, speakerOn, recs.at(-1));
        if (sent.ok) break;
        if (attempt === 2) { log('ding: greeting still not clean after a retry:', sent.why); break; }
        if (/call ended/.test(sent.why)) {
          call = await camera.startLiveCall();
          const again = film(call);
          if (again) { again.who = found.name || null; recs.push(again); }
          call.activateCameraSpeaker();
          speakerOn = Date.now();
        } else {
          speakerOn = Date.now() - SPEAKER_MS;   // same call, speaker already warm
        }
        log('ding: saying it again');
      }
      call.stop();
      cleanLive();
    } catch (e) {
      log('greeting failed:', e.message);
    } finally {
      busy = false;
      if (walkUp) { recs.push(walkUp); walkUp = null; }   // the greeting failed before it knew anyone
      for (const rec of recs) keepFilm(rec).catch((e) => log('film:', e.message));
    }
  });
}

main().catch((e) => { log('stopped:', e.message); process.exit(1); });
