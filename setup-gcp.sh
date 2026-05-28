#!/bin/bash
# REA + ArthaOS — GCP server setup script
# Run this on the GCP server after: git clone https://github.com/kshitijmodi/Remote-Engineering-Agents ~/rea
# Usage: cd ~/rea && bash setup-gcp.sh

set -e

echo "=== REA GCP Setup ==="

# ── 1. System dependencies for whatsapp-web.js (puppeteer/Chromium) ──────────
echo "[1/5] Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
  libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
  libxrandr2 libxrender1 libxss1 libxtst6 wget xdg-utils

# ── 2. Node dependencies ──────────────────────────────────────────────────────
echo "[2/5] Installing npm packages..."
npm install --omit=dev

# ── 3. Workspace: symlink ArthaOS (already lives at ~/arthaos) ───────────────
echo "[3/5] Setting up workspace..."
mkdir -p workspace
if [ ! -L workspace/ArthaOS ]; then
  ln -s ~/arthaos workspace/ArthaOS
  echo "  Symlinked ~/arthaos → workspace/ArthaOS"
else
  echo "  workspace/ArthaOS symlink already exists"
fi

# ── 4. Create .env ────────────────────────────────────────────────────────────
echo "[4/5] Creating .env..."
if [ -f .env ]; then
  echo "  .env already exists — skipping (edit manually if needed)"
else
  cat > .env << 'EOF'
ALLOWED_NUMBERS=15513582416@c.us,112545708945542@lid

# ArthaOS on same machine — use localhost
ARTHAOS_API_URL=http://localhost:8000
ARTHAOS_ALERT_PORT=8001
EOF
  echo "  .env created"
fi

# ── 5. PM2 ───────────────────────────────────────────────────────────────────
echo "[5/5] Setting up PM2..."
if pm2 describe rea > /dev/null 2>&1; then
  echo "  PM2 process 'rea' already exists — restarting..."
  pm2 restart rea
else
  echo ""
  echo "  *** SCAN QR CODE STEP ***"
  echo "  Run: node index.js"
  echo "  Scan the QR code with WhatsApp Business on your phone."
  echo "  Once you see '[WhatsApp] Connected and ready.' — press Ctrl+C"
  echo "  Then run: pm2 start index.js --name rea && pm2 save"
  echo ""
fi

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. node index.js          (scan QR code once)"
echo "  2. pm2 start index.js --name rea"
echo "  3. pm2 save               (persist across reboots)"
echo "  4. Share your GCP Tailscale IP so nginx can be locked down"
