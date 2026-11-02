#!/bin/bash
# One-time install: the Node packages, a Python environment for face matching, and your own copies
# of the settings files. Safe to run again.
#   ./setup.sh                 (PYTHON=python3.12 ./setup.sh to pick a Python)
set -e
cd "$(dirname "$0")"

need() { command -v "$1" > /dev/null 2>&1 || { echo "Missing: $1. $2"; exit 1; }; }
need node "Install Node.js 22 or newer (Mac: brew install node, or the installer from nodejs.org)."
need npm "It comes with Node.js."
need ffmpeg "Mac: brew install ffmpeg. Linux: sudo apt install ffmpeg."
PY=${PYTHON:-python3}
need "$PY" "Install Python 3.10 or newer (Mac: brew install python@3.12. Linux: sudo apt install python3 python3-venv)."
"$PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)' \
  || { echo "Python 3.10 or newer needed (you have $("$PY" --version 2>&1))."; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || { echo "Node.js 22 or newer needed (you have $(node --version))."; exit 1; }

echo "1/4  Node packages"
npm install --no-fund --no-audit

echo "2/4  Python environment for face matching (.venv)"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt
# face_recognition asks for dlib, which pip would build from source (slow, and it needs cmake).
# dlib-bin, from requirements.txt, is the same library ready-built, so face_recognition goes in
# without pulling its own dependencies.
.venv/bin/python -m pip install --quiet --no-deps face_recognition==1.3.0
.venv/bin/python -c "import face_recognition" && echo "     face matching ready"

echo "3/4  Your settings"
[ -f config.json ] || { cp config.example.json config.json; echo "     made config.json"; }
[ -f lines.json ] || { cp lines.example.json lines.json; echo "     made lines.json"; }
mkdir -p data/faces data/lines
chmod 700 data

echo "4/4  Check"
node check.mjs --offline || true
echo
echo "Installed. Next: README step 3, sign in to Ring with: node login.mjs"
