#!/usr/bin/env bash
set -euo pipefail

version="4.131.0"
bind_port="8080"
https_port="8443"
proxy_mode="auto"

usage() {
  cat <<'EOF'
Usage: install-code-server.sh [options]

Options:
  --bind-port PORT       Local loopback port (default: 8080)
  --https-port PORT      Tailscale Serve HTTPS port (default: 8443)
  --proxy auto|none|URL  Prefer a working local Clash proxy, disable proxy,
                         or use an explicit HTTP proxy URL
  -h, --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bind-port) bind_port="$2"; shift 2 ;;
    --https-port) https_port="$2"; shift 2 ;;
    --proxy) proxy_mode="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$bind_port" =~ ^[0-9]+$ ]] || { echo "Invalid bind port" >&2; exit 2; }
[[ "$https_port" =~ ^[0-9]+$ ]] || { echo "Invalid HTTPS port" >&2; exit 2; }
command -v curl >/dev/null
command -v sha256sum >/dev/null
command -v systemctl >/dev/null
command -v tailscale >/dev/null

case "$(uname -m)" in
  x86_64|amd64)
    arch="amd64"
    expected_sha="f6316f0b14ef5c12ed6e67e0154dd02ccf5e66112064687d7e93c51763105361"
    ;;
  aarch64|arm64)
    arch="arm64"
    expected_sha="4d2a8b2f755446079c4364b18e71c9121181e4e605c6c35939e5f1aac8d1eae8"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

resolved_proxy=""
case "$proxy_mode" in
  auto)
    local_proxy_ok=false
    for _ in 1 2 3; do
      if curl --proxy http://127.0.0.1:7897 -fsSI \
        --connect-timeout 5 --max-time 12 https://github.com/ >/dev/null 2>&1; then
        local_proxy_ok=true
        break
      fi
      sleep 1
    done
    if [[ "$local_proxy_ok" == true ]]; then
      resolved_proxy="http://127.0.0.1:7897"
      echo "Using the host-local Clash proxy at $resolved_proxy"
    else
      echo "Host-local Clash was not available; using direct GitHub access"
    fi
    ;;
  none)
    echo "Using direct GitHub access"
    ;;
  http://*|https://*)
    resolved_proxy="$proxy_mode"
    ;;
  *)
    echo "Invalid proxy value: $proxy_mode" >&2
    exit 2
    ;;
esac

curl_args=(
  --fail
  --location
  --retry 3
  --retry-delay 2
  --connect-timeout 15
)
if [[ -n "$resolved_proxy" ]]; then
  curl_args+=(--proxy "$resolved_proxy")
fi

cache_dir="${HOME}/.cache/codex-mobile-downloads"
archive="${cache_dir}/code-server-${version}-linux-${arch}.tar.gz"
url="https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-linux-${arch}.tar.gz"
mkdir -p "$cache_dir"

archive_ok=false
if [[ -f "$archive" ]]; then
  actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "$actual_sha" == "$expected_sha" ]] && archive_ok=true
fi
if [[ "$archive_ok" != true ]]; then
  rm -f "${archive}.part"
  curl "${curl_args[@]}" --output "${archive}.part" "$url"
  actual_sha="$(sha256sum "${archive}.part" | awk '{print $1}')"
  [[ "$actual_sha" == "$expected_sha" ]] || {
    echo "SHA-256 verification failed" >&2
    rm -f "${archive}.part"
    exit 1
  }
  mv -f "${archive}.part" "$archive"
fi
echo "Verified code-server ${version} (${arch})"

lib_dir="${HOME}/.local/lib"
target="${lib_dir}/code-server-${version}-linux-${arch}"
mkdir -p "$lib_dir" "${HOME}/.local/bin"
if [[ ! -x "${target}/bin/code-server" ]]; then
  tar -xzf "$archive" -C "$lib_dir"
fi
ln -sfn "${target}/bin/code-server" "${HOME}/.local/bin/code-server"

config_dir="${HOME}/.config/code-server"
config_file="${config_dir}/config.yaml"
mkdir -p "$config_dir"
chmod 700 "$config_dir"
if [[ ! -e "$config_file" ]]; then
  umask 077
  if command -v openssl >/dev/null; then
    password="$(openssl rand -hex 24)"
  else
    password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  cat > "$config_file" <<EOF
bind-addr: 127.0.0.1:${bind_port}
auth: password
password: "${password}"
cert: false
EOF
else
  grep -Eq "^bind-addr:[[:space:]]*127\\.0\\.0\\.1:${bind_port}[[:space:]]*$" "$config_file" &&
    grep -Eq '^auth:[[:space:]]*password[[:space:]]*$' "$config_file" &&
    grep -Eq '^cert:[[:space:]]*false[[:space:]]*$' "$config_file" || {
      echo "Existing $config_file is incompatible; it was not modified" >&2
      exit 1
    }
fi
chmod 600 "$config_file"

unit_dir="${HOME}/.config/systemd/user"
unit_file="${unit_dir}/code-server.service"
mkdir -p "$unit_dir"
{
  cat <<EOF
[Unit]
Description=code-server mobile editor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/code-server --config %h/.config/code-server/config.yaml
Restart=on-failure
RestartSec=3
UMask=0077
EOF
  if [[ -n "$resolved_proxy" ]]; then
    cat <<EOF
Environment=HTTP_PROXY=${resolved_proxy}
Environment=HTTPS_PROXY=${resolved_proxy}
Environment=http_proxy=${resolved_proxy}
Environment=https_proxy=${resolved_proxy}
Environment=NO_PROXY=127.0.0.1,localhost
Environment=no_proxy=127.0.0.1,localhost
EOF
  fi
  cat <<'EOF'

[Install]
WantedBy=default.target
EOF
} > "$unit_file"

systemctl --user daemon-reload
systemctl --user enable --now code-server.service
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${bind_port}/login" >/dev/null; then
    break
  fi
  sleep 1
done

[[ "$(systemctl --user is-active code-server.service)" == "active" ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${bind_port}/login")" == "200" ]]
ss -lntH | awk -v address="127.0.0.1:${bind_port}" '$4 == address { found=1 } END { exit !found }'

tailscale serve --bg --https="$https_port" "http://127.0.0.1:${bind_port}" >/dev/null
tailscale serve status | grep -F ":${https_port} (tailnet only)" >/dev/null
tailscale serve status | grep -F "proxy http://127.0.0.1:${bind_port}" >/dev/null

echo
echo "code-server is active and restricted to the local loopback interface."
echo "Tailscale Serve HTTPS port: ${https_port} (tailnet only)"
echo "The existing password was preserved if the config already existed."
echo "Read the password locally with:"
echo "  sed -n 's/^password: *\"\\{0,1\\}\\([^\"]*\\)\"\\{0,1\\}\$/\\1/p' ~/.config/code-server/config.yaml"
