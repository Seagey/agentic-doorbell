"""Optional, macOS only: copy face photos for people you have named in the Photos app (People) into
data/faces/<name>/, on this computer only. Reads a copy of the Photos database and the preview
images Photos already keeps, crops around each face, and keeps the clearest ones. Then run
match.py --build.
  export_faces.py --list                 named people in Photos and how many faces each has
  export_faces.py "Sam" "Alex" ...       names exactly as in Photos > People

Your terminal needs Full Disk Access to read the Photos library (System Settings > Privacy &
Security > Full Disk Access). Photos only keeps previews for photos that are on this Mac, so with
iCloud Photos set to "Optimise Mac Storage" some people may get fewer photos."""
import os, shutil, sqlite3, sys, tempfile

from PIL import Image, ImageOps

LIB = os.path.expanduser(os.environ.get("PHOTOS_LIBRARY", "~/Pictures/Photos Library.photoslibrary"))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "faces")
PER_PERSON = 15


def db():
    src = os.path.join(LIB, "database", "Photos.sqlite")
    if not os.path.exists(src):
        sys.exit("No Photos library at %s (set PHOTOS_LIBRARY to its path)" % LIB)
    tmp = os.path.join(tempfile.mkdtemp(), "photos.sqlite")
    shutil.copy(src, tmp)
    return sqlite3.connect(tmp)


NAME = "coalesce(nullif(p.ZDISPLAYNAME, ''), p.ZFULLNAME)"


def named(con):
    return con.execute(f"select {NAME}, p.ZFACECOUNT from ZPERSON p where {NAME} is not null and {NAME} != '' "
                       "order by p.ZFACECOUNT desc").fetchall()


def faces(con, name):
    return con.execute(f"""
        select a.ZUUID, a.ZDIRECTORY, f.ZCENTERX, f.ZCENTERY, f.ZSIZE
        from ZDETECTEDFACE f join ZPERSON p on f.ZPERSONFORFACE = p.Z_PK join ZASSET a on f.ZASSETFORFACE = a.Z_PK
        where {NAME} = ? and coalesce(f.ZHIDDEN, 0) = 0 and coalesce(f.ZISINTRASH, 0) = 0 and a.ZTRASHEDSTATE = 0
        order by f.ZQUALITY desc""", (name,)).fetchall()


def preview(uuid, directory):
    for sub in ("resources/derivatives", "resources/derivatives/masters"):
        for suffix in ("_1_105_c.jpeg", "_4_5005_c.jpeg", "_1_102_o.jpeg"):
            p = os.path.join(LIB, sub, directory[:1] if directory else uuid[:1], uuid + suffix)
            if os.path.exists(p):
                return p
    return None


def export(con, name):
    folder = os.path.join(OUT, name)
    os.makedirs(folder, exist_ok=True)
    kept = 0
    for uuid, directory, cx, cy, size in faces(con, name):
        src = preview(uuid, directory)
        if not src or not size:
            continue
        im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        w, h = im.size
        side = size * min(w, h) * 2.4          # a generous square round the face
        x, y = cx * w, (1 - cy) * h             # Photos measures y from the bottom
        box = (int(max(0, x - side / 2)), int(max(0, y - side / 2)), int(min(w, x + side / 2)), int(min(h, y + side / 2)))
        if box[2] - box[0] < 80 or box[3] - box[1] < 80:
            continue
        im.crop(box).save(os.path.join(folder, f"{kept:02d}.jpg"), quality=90)
        kept += 1
        if kept >= PER_PERSON:
            break
    return kept


if __name__ == "__main__":
    if sys.argv[1:2] in (["--help"], ["-h"]):
        print(__doc__)
        sys.exit(0)
    con = db()
    if sys.argv[1:] == ["--list"] or not sys.argv[1:]:
        people = named(con)
        if not people:
            print("No named people in Photos yet. Open Photos > People, name a few, wait for it to finish, then try again.")
        for n, c in people:
            print(f"{n}: {c} faces")
        sys.exit(0)
    for name in sys.argv[1:]:
        print(name, export(con, name), "face photos")
