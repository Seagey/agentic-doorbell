"""Who is at the door. Compares one picture with the reference photos in data/faces/<name>/*.jpg, on
this computer only, and prints JSON: {"name": <name or null>, "distance": <best>, "faces": <count>}.
The picture is deleted afterwards unless --keep, so a stranger's face is never stored.
  match.py <picture.jpg> [--keep]
  match.py --build      read the reference photos again (after adding or changing people)
  match.py --serve      stay running: one picture path per line on stdin, one JSON line back each
                        (the greeter keeps this open, so the face model loads once, not per frame)"""
import json, os, pickle, sys

import face_recognition

HERE = os.path.dirname(os.path.abspath(__file__))
FACES = os.path.join(HERE, "data", "faces")
CACHE = os.path.join(HERE, "data", "faces.pkl")


def threshold():
    # face_recognition's distance: lower is closer. 0.6 is the library's default; 0.5 is stricter and
    # was right for a fisheye doorbell camera. Set "threshold" in config.json to change it.
    try:
        with open(os.path.join(HERE, "config.json")) as fh:
            return float(json.load(fh).get("threshold", 0.5))
    except (OSError, ValueError):
        return 0.5


THRESHOLD = threshold()


def build():
    known, skipped = [], []
    for name in sorted(os.listdir(FACES)) if os.path.isdir(FACES) else []:
        folder = os.path.join(FACES, name)
        if not os.path.isdir(folder):
            continue
        for f in sorted(os.listdir(folder)):
            if f.lower().endswith((".jpg", ".jpeg", ".png")):
                img = face_recognition.load_image_file(os.path.join(folder, f))
                enc = face_recognition.face_encodings(img)
                if len(enc) == 1:   # only photos with exactly one face, so we know whose it is
                    known.append((name, enc[0]))
                else:
                    skipped.append("%s/%s (%d faces)" % (name, f, len(enc)))
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, "wb") as fh:
        pickle.dump(known, fh)
    os.chmod(CACHE, 0o600)
    return known, skipped


def load():
    if not os.path.exists(CACHE):
        return build()[0]
    with open(CACHE, "rb") as fh:
        return pickle.load(fh)


def match(path, known=None):
    known = known if known is not None else load()
    img = face_recognition.load_image_file(path)
    # One upsample finds a face at the door in about 0.4 s; two take about 1.7 s, so only when one found none.
    locs = face_recognition.face_locations(img, number_of_times_to_upsample=1) or \
        face_recognition.face_locations(img, number_of_times_to_upsample=2)
    found = face_recognition.face_encodings(img, locs)
    best = (None, 9.0)
    for enc in found:
        for name, ref in known:
            d = float(face_recognition.face_distance([ref], enc)[0])
            if d < best[1]:
                best = (name, d)
    name = best[0] if best[1] <= THRESHOLD else None
    return {"name": name, "distance": round(best[1], 3) if found and known else None, "faces": len(found)}


if __name__ == "__main__":
    if sys.argv[1:2] in (["--help"], ["-h"]) or not sys.argv[1:]:
        print(__doc__)
        sys.exit(0)
    if sys.argv[1:2] == ["--build"]:
        k, skipped = build()
        people = sorted({n for n, _ in k})
        print(json.dumps({"people": people, "photos": len(k)}))
        for s in skipped:
            print("  skipped " + s + ": needs exactly one face", file=sys.stderr)
        for name in people:
            n = sum(1 for p, _ in k if p == name)
            if n < 5:
                print("  %s has only %d usable photos: add a few more (5 to 15 is best)" % (name, n), file=sys.stderr)
        sys.exit(0)
    if sys.argv[1:2] == ["--serve"]:
        known = load()
        for line in sys.stdin:
            path = line.strip()
            if not path:
                continue
            try:
                out = match(path, known)
            except Exception as e:
                out = {"name": None, "error": str(e)[:120]}
            finally:
                if os.path.exists(path):
                    os.remove(path)
            print(json.dumps(out), flush=True)
        sys.exit(0)
    path = sys.argv[1]
    try:
        print(json.dumps(match(path)))
    finally:
        if "--keep" not in sys.argv and os.path.exists(path):
            os.remove(path)
