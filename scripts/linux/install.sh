#!/usr/bin/env bash
set -euo pipefail

workspace=""
port="8787"
install_dir="${HOME}/.local/share/codex-mobile-pwa"
data_dir="${HOME}/.config/codex-mobile-pwa"
codex_path="${CODEX_PATH:-$(command -v codex || true)}"
file_roots=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) workspace="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --install-dir) install_dir="$2"; shift 2 ;;
    --data-dir) data_dir="$2"; shift 2 ;;
    --codex) codex_path="$2"; shift 2 ;;
    --file-root) file_roots+=("$2"); shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$workspace" ]] || { echo "--workspace is required" >&2; exit 2; }
workspace="$(realpath "$workspace")"
[[ -d "$workspace" ]] || { echo "Workspace not found: $workspace" >&2; exit 1; }
node_path="${NODE_PATH:-$(command -v node || true)}"
if [[ -z "$node_path" ]] || ! "$node_path" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
  existing_node_path="$(
    systemctl --user show codex-mobile-pwa.service -p ExecStart --value 2>/dev/null |
      sed -n 's/.*path=\([^ ;]*\).*/\1/p'
  )"
  if [[ -x "$existing_node_path" ]]; then
    node_path="$existing_node_path"
  fi
fi
[[ -x "$node_path" ]] || { echo "Node.js executable not found" >&2; exit 1; }
node_dir="$(dirname "$node_path")"
npm_path="$node_dir/npm"
[[ -x "$npm_path" ]] || npm_path="$(command -v npm)"
"$node_path" -e '
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.error(`Node.js 20 or newer is required; found ${process.version}`);
    process.exit(1);
  }
'
[[ -x "$codex_path" ]] || { echo "Codex executable not found: $codex_path" >&2; exit 1; }
for index in "${!file_roots[@]}"; do
  [[ -d "${file_roots[$index]}" ]] || {
    echo "File root not found: ${file_roots[$index]}" >&2
    exit 1
  }
  file_roots[$index]="$(realpath "${file_roots[$index]}")"
done
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
service_dir="${HOME}/.config/systemd/user"
service_file="${service_dir}/codex-mobile-pwa.service"

mkdir -p "$install_dir" "$data_dir" "$service_dir"
if [[ -f "$install_dir/config.json" ]]; then
  cp -p "$install_dir/config.json" "$install_dir/config.json.backup-$(date +%Y%m%d-%H%M%S)"
fi
cp -a "$repo_root/gateway/." "$install_dir/"
(cd "$install_dir" && PATH="$node_dir:$PATH" "$npm_path" ci --omit=dev --no-audit --no-fund)
WORKSPACE="$workspace" PORT="$port" CODEX="$codex_path" "$node_path" -e '
  const fs = require("fs");
  const os = require("os");
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  } catch {}
  const workspaceName = require("path").basename(process.env.WORKSPACE) || process.env.WORKSPACE;
  const workspaces =
    Array.isArray(existing.workspaces) && existing.workspaces.length
      ? existing.workspaces
      : [{ id: "default", name: workspaceName, path: process.env.WORKSPACE }];
  if (!workspaces.some((entry) => entry.path === process.env.WORKSPACE)) {
    workspaces.push({
      id: `workspace-${workspaces.length + 1}`,
      name: workspaceName,
      path: process.env.WORKSPACE
    });
  }
  const defaultHostId =
    os.hostname().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") ||
    "linux-host";
  const host =
    existing.host && typeof existing.host === "object"
      ? existing.host
      : { id: defaultHostId, name: os.hostname(), url: "" };
  const hosts =
    Array.isArray(existing.hosts) && existing.hosts.length
      ? existing.hosts
      : [host];
  const requestedFileRoots = process.argv.slice(2);
  const fileRoots =
    Array.isArray(existing.fileRoots) && existing.fileRoots.length
      ? [...existing.fileRoots]
      : [];
  for (const root of requestedFileRoots) {
    if (!fileRoots.includes(root)) fileRoots.push(root);
  }
  if (!fileRoots.length) fileRoots.push(os.homedir());
  const value = {
    port: Number(process.env.PORT),
    workspace: process.env.WORKSPACE,
    workspaces,
    host,
    hosts,
    codexPath: process.env.CODEX,
    defaultPermissionMode:
      existing.defaultPermissionMode === "full" ? "full" : "workspace",
    webPushSubject: existing.webPushSubject || "",
    fileRoots,
    maxUploadBytes: Number(existing.maxUploadBytes) || 25 * 1024 * 1024,
    maxAttachments: Number(existing.maxAttachments) || 8
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
' "$install_dir/config.json" "${file_roots[@]}"

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
