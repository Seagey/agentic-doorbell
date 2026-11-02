"""How well it tells your people apart. Holds each reference photo out, matches it against all the
others, and counts right, wrong and "nobody". Reads data/faces.pkl only (run match.py --build first).
  face_test.py"""
import os, pickle, sys

import face_recognition

from match import CACHE, THRESHOLD

if not os.path.exists(CACHE):
    sys.exit("No face index yet. Run: .venv/bin/python match.py --build")
known = pickle.load(open(CACHE, "rb"))
if len(known) < 2:
    sys.exit("Need at least two photos in the index to test.")
right = wrong = none = 0
mix = {}
for i, (name, enc) in enumerate(known):
    rest = [(n, e) for j, (n, e) in enumerate(known) if j != i]
    d = face_recognition.face_distance([e for _, e in rest], enc)
    k = int(d.argmin())
    guess = rest[k][0] if d[k] <= THRESHOLD else None
    if guess == name:
        right += 1
    elif guess is None:
        none += 1
    else:
        wrong += 1
        mix[(name, guess)] = mix.get((name, guess), 0) + 1
print("%d photos at threshold %s: right %d, wrong %d, nobody %d" % (len(known), THRESHOLD, right, wrong, none))
for (a, b), c in sorted(mix.items(), key=lambda x: -x[1]):
    print("  %s taken for %s: %d" % (a, b, c))
if wrong:
    print("Some people were mixed up: lower the threshold in config.json (try 0.45), or add clearer photos.")
