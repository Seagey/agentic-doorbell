// Makes the greetings in lines.json into sound files, in data/lines/<name>/. Made once and kept: the
// greeter only plays files, it never calls a voice service when someone is at the door.
//
//   node voice.mjs                 make every greeting that has no sound file yet
//   node voice.mjs NAME            make (or remake) just that one ("_stranger" for strangers)
//   node voice.mjs --dry-run       show what it would make, change nothing
//
// Voices:
//   --computer     the computer's own voice (macOS "say", or espeak-ng on Linux). Free. The default
//                  when no ElevenLabs key is set.
//   --elevenlabs   an ElevenLabs voice, including a clone of your own. Needs ELEVENLABS_API_KEY (in
//                  your environment or a .env file in this folder) and "elevenlabs": {"voice": ...}
//                  in config.json (the voice's name or id). Uses about one character of your plan
//                  per letter.
//   --force        replace greetings that already have a file
//
// Your own recording needs none of this: put an mp3, wav or m4a in data/lines/<name>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HERE, LINES, loadConfig } from './config.mjs';

const run = promisify(execFile);
const cfg = loadConfig();
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const who = args.find((a) => !a.startsWith('--'));
const dry = flag('--dry-run');

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const env = path.join(HERE, '.env');
  if (!fs.existsSync(env)) return null;
  return (fs.readFileSync(env, 'utf8').match(/^ELEVENLABS_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || null;
}

const engine = flag('--elevenlabs') ? 'elevenlabs' : flag('--computer') ? 'computer'
  : (apiKey() && cfg.elevenlabs.voice ? 'elevenlabs' : 'computer');

const linesFile = path.join(HERE, 'lines.json');
if (!fs.existsSync(linesFile)) {
  console.error('No lines.json yet. Copy lines.example.json to lines.json and write your greetings (README step 6).');
  process.exit(1);
}
const lines = Object.entries(JSON.parse(fs.readFileSync(linesFile, 'utf8'))).filter(([k, v]) => !k.startsWith('_help') && typeof v === 'string');
const hasSound = (name) => fs.existsSync(path.join(LINES, name)) &&
  fs.readdirSync(path.join(LINES, name)).some((f) => /\.(mp3|wav|m4a)$/i.test(f));

// A folder with any file not called line.* holds your own recording: left alone unless named.
const ownRecording = (name) => fs.existsSync(path.join(LINES, name)) &&
  fs.readdirSync(path.join(LINES, name)).some((f) => /\.(mp3|wav|m4a)$/i.test(f) && !/^line\./.test(f));
const todo = lines.filter(([name]) => (who ? name === who : !ownRecording(name) && (flag('--force') || !hasSound(name))));
if (who && !todo.length) { console.error(`"${who}" is not in lines.json`); process.exit(1); }
if (!todo.length) { console.log('Every greeting in lines.json already has a sound file. Use --force to remake them.'); process.exit(0); }

let voiceId = null;
async function elevenlabs(text, out) {
  const key = apiKey();
  if (!key) throw new Error('no ELEVENLABS_API_KEY (set it in your environment or in a .env file in this folder)');
  const H = { 'xi-api-key': key };
  if (!voiceId) {
    const want = cfg.elevenlabs.voice;
    if (!want) throw new Error('set "elevenlabs": {"voice": "<voice name or id>"} in config.json');
    const voices = await (await fetch('https://api.elevenlabs.io/v1/voices', { headers: H })).json();
    const v = (voices.voices || []).find((x) => x.voice_id === want || x.name === want);
    if (!v) throw new Error(`ElevenLabs voice "${want}" not found on your account`);
    voiceId = v.voice_id;
  }
  // Speed 0.7 is ElevenLabs' slowest. Greetings at normal speed came out too quick to follow through
  // a doorbell speaker; a slow, clear line works better at the door.
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.25, speed: Number(cfg.elevenlabs.speed) || 0.7 } }),
  });
  if (!r.ok) throw new Error(`ElevenLabs said ${r.status}: ${(await r.text()).slice(0, 200)}`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}

async function computer(text, out) {
  const mac = process.platform === 'darwin';
  const tmp = path.join(os.tmpdir(), `agentic-doorbell-${Date.now()}.${mac ? 'aiff' : 'wav'}`);
  if (mac) {
    await run('say', ['-r', '165', '-o', tmp, text]);
  } else {
    await run('espeak-ng', ['-s', '140', '-w', tmp, text]).catch(() => {
      throw new Error('no computer voice found: install espeak-ng (sudo apt install espeak-ng)');
    });
  }
  await run(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-ac', '1', '-ar', '22050', out]);
  fs.rmSync(tmp, { force: true });
}

console.log(`${dry ? 'Would make' : 'Making'} ${todo.length} greeting(s) with the ${engine === 'elevenlabs' ? 'ElevenLabs' : 'computer'} voice:`);
for (const [name, text] of todo) {
  const dir = path.join(LINES, name);
  const out = path.join(dir, engine === 'elevenlabs' ? 'line.mp3' : 'line.wav');
  console.log(`  ${name}: "${text}"${engine === 'elevenlabs' ? ` (${text.length} characters)` : ''}`);
  if (dry) continue;
  fs.mkdirSync(dir, { recursive: true });
  const fresh = out.replace(/(\.\w+)$/, '.new$1');   // the old greeting stays until the new one is made
  try {
    if (engine === 'elevenlabs') await elevenlabs(text, fresh); else await computer(text, fresh);
    for (const f of fs.readdirSync(dir)) if (/^line\.(mp3|wav)$/.test(f)) fs.rmSync(path.join(dir, f));
    fs.renameSync(fresh, out);
    console.log(`    saved ${path.relative(HERE, out)}`);
  } catch (e) {
    fs.rmSync(fresh, { force: true });
    console.error(`    failed: ${e.message}`);
    process.exitCode = 1;
  }
}
