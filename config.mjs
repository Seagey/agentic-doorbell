// Settings shared by every script. Copy config.example.json to config.json and change what you need;
// anything you leave out uses the default below. README "Settings" explains each one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.join(HERE, 'data');                 // never in git: token, faces, lines
export const TOKEN = path.join(DATA, 'ring-token.json');
export const FACES = path.join(DATA, 'faces');               // faces/<name>/*.jpg
export const LINES = path.join(DATA, 'lines');               // lines/<name>/*.mp3|wav|m4a
export const FILM = path.join(HERE, 'film');                 // film mode recordings
export const FILM_FLAG = path.join(DATA, 'film-mode');

const DEFAULTS = {
  camera: 'Front Door',
  threshold: 0.5,
  lookOnPressSeconds: 10,
  lookOnMotionSeconds: 15,
  motion: true,
  speakerWarmUpSeconds: 3.5,
  filmPeople: [],
  elevenlabs: { voice: '', speed: 0.7 },
  python: '.venv/bin/python',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
};

export function loadConfig() {
  const file = path.join(HERE, 'config.json');
  let mine = {};
  if (fs.existsSync(file)) {
    try { mine = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`config.json is not valid JSON: ${e.message}`); }
  }
  const c = { ...DEFAULTS, ...mine, elevenlabs: { ...DEFAULTS.elevenlabs, ...(mine.elevenlabs || {}) } };
  c.python = path.isAbsolute(c.python) ? c.python : path.join(HERE, c.python);
  c.hasFile = fs.existsSync(file);
  return c;
}

export function readToken() {
  if (!fs.existsSync(TOKEN)) return null;
  return JSON.parse(fs.readFileSync(TOKEN, 'utf8')).refreshToken || null;
}

// Ring hands out a new refresh token as the old one is used, so every script saves it straight away.
// Only one program may use the token at a time: two copies refreshing it knock each other out.
export function saveToken(refreshToken) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN, JSON.stringify({ refreshToken, at: new Date().toISOString() }), { mode: 0o600 });
}
