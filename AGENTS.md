# agentic-doorbell: notes for the agent setting it up

Read README.md first. This file is what a person's agent needs to set it up with them. Follow the
README steps in order, run each command yourself, and tell the owner what you saw in plain words.

## Walk the owner through setup

1. **Check the basics.** Which computer will run it (it must stay on at home)? Which Ring doorbell
   do they have? Compare it with README "What doorbells it works with" and say plainly if theirs is
   tested, untested, or won't work (any other brand, a Ring camera with no button, or End-to-End
   Encryption on). A Eufy doorbell: follow README "Eufy" and tell them plainly it is built but not
   yet tested on a real Eufy, so they are the first. Intel Mac: make the `requirements.txt` swap the README describes before setup.
2. **Install.** Run `./setup.sh` and fix anything it stops on (missing Node, Python or ffmpeg).
3. **Ring sign-in.** Run `node login.mjs` (or `--lan` for their phone) and hand them the link.
   They type their own email, password and code. Then run `node check.mjs` and set `"camera"` in
   `config.json` if their doorbell is not called Front Door.
4. **People.** Ask who they want greeted. For each person, ask the owner to confirm that person has
   agreed. Help them put 5 to 15 photos per person in `data/faces/<name>/` (or run
   `export_faces.py` on a Mac whose Photos app has named people). Then `match.py --build` and
   `face_test.py`; aim for `wrong 0`.
5. **Greetings.** Write `lines.json` with them (their words, short, one per person, plus
   `_stranger`). Ask which voice: their own recording, the computer voice, or ElevenLabs. For
   ElevenLabs, they put the key in `.env` themselves, and you run `node voice.mjs --dry-run` first
   and tell them how many characters it will use before running it for real.
6. **Test.** `node greeter.mjs --test <name>` with the owner at the door listening. Then a real walk
   up and press.
7. **Keep it running** with the launchd, systemd or pm2 option in README step 9. On a Mac, check the
   folder is not in Desktop, Documents or Downloads.

Before you finish, say the must-haves out loud: the computer never sleeps, only one copy runs at a
time, and film mode records everyone while it is on.

## Ask the owner, never do it yourself

- **Signing in to Ring.** Never type, read or store their Ring password or code. Never read or print
  `data/ring-token.json`.
- **Signing in to Eufy.** They type it into `node eufy-login.mjs` themselves. Never read or print
  `data/eufy-login.json` or anything in `data/eufy/`.
- **Adding a face.** Only people the owner names and says have agreed. Never pull photos from social
  media or anywhere online.
- **Spending money.** ElevenLabs characters come out of their plan: say how many first.
- **Film mode.** Only on when they ask, and remind them to switch it off.

## Things that will bite you

- **One copy at a time.** Ring refresh tokens are used up as they refresh. Two programs on one
  token (the service plus `check.mjs`, `--test` or `probe-audio.mjs`) knock each other out and the
  owner has to sign in again. Stop the service before any of those.
- **Never use Ring snapshots.** A battery doorbell cannot take one while a live call streams, and the
  motion snapshot is taken before anyone faces the door. `lookLive()` reads the live call instead.
- **Never filter a copied video stream.** `startTranscoding` defaults to `-vcodec copy`; any video
  filter on top makes ffmpeg exit 234 and drops the call. Encode (`mjpeg`) when you need frames.
- **Do not use the library's `transcodeReturnAudio`** for the greeting. It sends stereo 48 kHz,
  which came out fast, buzzy and cut short on a Ring doorbell. `sendAudio()` sends mono 16 kHz Opus
  in 60 ms packets, pre-rendered with a quiet lead-in and paced in real time, and checks every
  packet. Keep the checker and the one resend.
- **Speaker warm-up.** The speaker is switched on as the call opens and the greeting waits
  `speakerWarmUpSeconds` after that. Lowering it cuts off the first words.
- **Keep the push-receiver override** in `package.json` (`@eneris/push-receiver` 4.4.0). Without it,
  some Ring alerts fail to decrypt with `ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY` and presses are missed.
- **Stale pushes are skipped on purpose** (over a minute old): a redelivered alert after a restart
  is not someone at the door now.
- **Faces stay local.** `match.py` deletes every frame it checks. Never add an upload, a cloud face
  service or a model call at ring time.

- **Eufy (eufy.mjs).** Import the library as a default import (`import eufyLib from
  'eufy-security-client'`): it is CommonJS and some named imports do not resolve. Talkback takes one
  AAC ADTS frame per write, paced in real time. The live view is shared by motion and the press,
  because opening a second one is slow.

## Checking your work

- `node check.mjs --offline` checks everything except Ring, with no sign-in.
- `node --check <file>.mjs` and `.venv/bin/python -m py_compile <file>.py` after any code change.
- `scripts/privacy-scan.sh` before any commit to a public fork (see its header).
