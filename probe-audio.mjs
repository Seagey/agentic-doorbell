// For troubleshooting a doorbell other than the one this was built on. Opens a live call, reports
// the audio format the doorbell sends (Opus or G.711) and the timing of its packets, then hangs up.
// Plays nothing. Stop the greeter first: only one program may use the Ring sign-in at a time.
//   node probe-audio.mjs
// The greeter sends Opus, mono, 16 kHz, in 60 ms packets, which is what a Ring Video Doorbell (2nd
// gen) sends. If yours says something different, open an issue with this output.
import { RingApi } from 'ring-client-api';
import { firstValueFrom, timeout, take, toArray } from 'rxjs';
import { loadConfig, readToken, saveToken } from './config.mjs';

const cfg = loadConfig();
const refreshToken = readToken();
if (!refreshToken) { console.error('Not signed in to Ring yet. Run: node login.mjs'); process.exit(1); }
const ring = new RingApi({ refreshToken, controlCenterDisplayName: 'agentic-doorbell' });
ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveToken(newRefreshToken));
const cams = await ring.getCameras();
const cam = cams.find((c) => c.name === cfg.camera) || cams.find((c) => c.isDoorbot);
if (!cam) { console.error('No Ring doorbell found on this account'); process.exit(1); }
console.log('doorbell:', cam.name, '|', cam.deviceType);
const call = await cam.startLiveCall();
await firstValueFrom(call.onVideoRtp.pipe(timeout(15000))).catch(() => null);
console.log('usingOpus:', await call.isUsingOpus);
const pkts = await firstValueFrom(call.onAudioRtp.pipe(take(20), toArray(), timeout(10000))).catch(() => []);
if (pkts.length > 1) {
  const p = pkts.map((r) => ({ pt: r.header.payloadType, ts: r.header.timestamp, len: r.payload.length }));
  const steps = p.slice(1).map((x, i) => x.ts - p[i].ts);
  console.log('doorbell audio: payload type', p[0].pt, '| timestamp step', [...new Set(steps)].slice(0, 4).join(','), '| payload bytes', p[0].len);
} else console.log('no audio packets from the doorbell');
call.stop();
ring.disconnect();
process.exit(0);
