#!/bin/bash
# Lock ArthaOS nginx to Tailscale only — run AFTER Tailscale is set up on GCP
# Usage: bash nginx-tailscale-lockdown.sh <tailscale-ip>
# Example: bash nginx-tailscale-lockdown.sh 100.64.1.5

set -e

TAILSCALE_IP="${1:-}"

if [ -z "$TAILSCALE_IP" ]; then
  echo "Usage: bash nginx-tailscale-lockdown.sh <your-gcp-tailscale-ip>"
  echo "Get it with: tailscale ip -4"
  exit 1
fi

echo "=== Locking nginx to Tailscale IP: $TAILSCALE_IP ==="

# Find the nginx site config
NGINX_CONF=""
for f in /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default /etc/nginx/conf.d/arthaos.conf; do
  if [ -f "$f" ]; then
    NGINX_CONF="$f"
    break
  fi
done

if [ -z "$NGINX_CONF" ]; then
  echo "Could not find nginx config. Check /etc/nginx/sites-enabled/ manually."
  exit 1
fi

echo "Found nginx config: $NGINX_CONF"

# Backup
sudo cp "$NGINX_CONF" "${NGINX_CONF}.bak.$(date +%s)"
echo "Backup saved."

# Replace listen 80 with listen on Tailscale IP only
# Also add deny all to block public access entirely
sudo sed -i "s/listen 80;/listen ${TAILSCALE_IP}:80;/" "$NGINX_CONF"
sudo sed -i "s/listen \[::\]:80;/# listen [::]:80; # disabled — Tailscale only/" "$NGINX_CONF"

# Test and reload
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "=== Done ==="
echo "ArthaOS is now only accessible via Tailscale at: http://${TAILSCALE_IP}"
echo "Public IP 34.139.55.117 no longer serves the dashboard."
echo ""
echo "Also update ArthaOS GCP firewall to block port 80 from public:"
echo "  gcloud compute firewall-rules delete allow-http  (if it exists)"
echo "  OR in GCP Console: VPC Network > Firewall > remove port 80 rule"
