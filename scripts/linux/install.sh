#!/usr/bin/env bash
set -euo pipefail

workspace=""
port="8787"
install_dir="${HOME}/.local/share/codex-mobile-pwa"
data_dir="${HOME}/.config/codex-mobile-pwa"
codex_path="${CODEX_PATH:-$(command -v codex || true)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) workspace="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --install-dir) install_dir="$2"; shift 2 ;;
    --data-dir) data_dir="$2"; shift 2 ;;
    --codex) codex_path="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$workspace" ]] || { echo "--workspace is required" >&2; exit 2; }
workspace="$(realpath "$workspace")"
[[ -d "$workspace" ]] || { echo "Workspace not found: $workspace" >&2; exit 1; }
node_path="$(command -v node)"
[[ -x "$codex_path" ]] || { echo "Codex executable not found: $codex_path" >&2; exit 1; }
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
service_dir="${HOME}/.config/systemd/user"
service_file="${service_dir}/codex-mobile-pwa.service"

mkdir -p "$install_dir" "$data_dir" "$service_dir"
if [[ -f "$install_dir/config.json" ]]; then
  cp -p "$install_dir/config.json" "$install_dir/config.json.backup-$(date +%Y%m%d-%H%M%S)"
fi
cp -a "$repo_root/gateway/." "$install_dir/"
WORKSPACE="$workspace" PORT="$port" CODEX="$codex_path" node -e '
  const fs = require("fs");
  const value = {
    port: Number(process.env.PORT),
    workspace: process.env.WORKSPACE,
    codexPath: process.env.CODEX,
    maxUploadBytes: 25 * 1024 * 1024,
    maxAttachments: 8
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
' "$install_dir/config.json"

cat > "$service_file" <<EOF
[Unit]
Description=Codex Mobile PWA gateway
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$install_dir
Environment=HOME=$HOME
Environment=PATH=$(dirname "$node_path"):$(dirname "$codex_path"):/usr/local/bin:/usr/bin:/bin
Environment=CODEX_PATH=$codex_path
Environment=CODEX_MOBILE_DATA_DIR=$data_dir
ExecStart=$node_path $install_dir/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
chmod 600 "$install_dir/config.json"
systemctl --user daemon-reload
systemctl --user enable --now codex-mobile-pwa

if command -v tailscale >/dev/null 2>&1; then
  tailscale serve --bg --yes "$port"
fi
for _ in {1..30}; do
  [[ -f "$data_dir/pairing-code.txt" ]] && break
  sleep 0.5
done
echo "Codex Mobile installed."
echo "Pairing code: $(cat "$data_dir/pairing-code.txt")"
systemctl --user --no-pager --full status codex-mobile-pwa | sed -n '1,12p'
command -v tailscale >/dev/null 2>&1 && tailscale serve status
