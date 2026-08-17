#!/usr/bin/env bash
# ABS Grok launcher

set -e
cd "$(dirname "$0")"

# Create venv if missing
if [ ! -d "venv" ]; then
  echo "Vytvářím virtuální prostředí…"
  python3 -m venv venv
fi

source venv/bin/activate

# Install / update dependencies
pip install -q --upgrade pip
pip install -q -r requirements.txt

echo ""
echo "Spouštím ABS Grok…"
echo "Otevři prohlížeč na:  http://127.0.0.1:8765"
echo "Ukončení: Ctrl+C"
echo ""

python abs_grok.py
