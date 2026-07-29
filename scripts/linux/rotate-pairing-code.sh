#!/usr/bin/env bash
set -euo pipefail
data_dir="${CODEX_MOBILE_DATA_DIR:-$HOME/.config/codex-mobile-pwa}"
stamp="$(date +%Y%m%d-%H%M%S)"
systemctl --user stop codex-mobile-pwa
for name in pairing-code.txt cookie-secret.txt; do
  [[ -f "$data_dir/$name" ]] && mv "$data_dir/$name" "$data_dir/$name.backup-$stamp"
done
systemctl --user start codex-mobile-pwa
for _ in {1..30}; do
  [[ -f "$data_dir/pairing-code.txt" ]] && break
  sleep 0.5
done
echo "New pairing code: $(cat "$data_dir/pairing-code.txt")"
