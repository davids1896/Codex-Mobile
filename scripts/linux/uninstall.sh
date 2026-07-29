#!/usr/bin/env bash
set -euo pipefail
remove_data="${1:-}"
install_dir="${HOME}/.local/share/codex-mobile-pwa"
data_dir="${HOME}/.config/codex-mobile-pwa"
systemctl --user disable --now codex-mobile-pwa 2>/dev/null || true
rm -f "${HOME}/.config/systemd/user/codex-mobile-pwa.service"
systemctl --user daemon-reload
rm -rf -- "$install_dir"
if [[ "$remove_data" == "--remove-data" ]]; then
  case "$(realpath -m "$data_dir")" in
    "$HOME/.config/codex-mobile-pwa") rm -rf -- "$data_dir" ;;
    *) echo "Refusing to remove unexpected data directory: $data_dir" >&2; exit 1 ;;
  esac
fi
echo "Codex Mobile removed. Tailscale Serve configuration was left unchanged."
