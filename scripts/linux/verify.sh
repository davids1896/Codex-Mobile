#!/usr/bin/env bash
set -euo pipefail
data_dir="${CODEX_MOBILE_DATA_DIR:-$HOME/.config/codex-mobile-pwa}"
config="${CODEX_MOBILE_CONFIG:-$HOME/.local/share/codex-mobile-pwa/config.json}"
port="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).port" "$config")"
codex_path="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).codexPath" "$config")"
echo "=== Service ==="
systemctl --user is-active codex-mobile-pwa
systemctl --user is-enabled codex-mobile-pwa
echo "=== HTTP ==="
curl -fsS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${port}/"
echo "=== Tailscale Serve ==="
tailscale serve status
echo "=== Codex ==="
"$codex_path" --version
echo "=== Pairing code ==="
cat "$data_dir/pairing-code.txt"
