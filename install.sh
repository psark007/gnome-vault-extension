#!/usr/bin/env bash
set -euo pipefail

if (( EUID == 0 )); then
    echo 'Run as your normal user, not with sudo.' >&2
    exit 1
fi

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/local-vaults@psark007.github.io"
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/local-vaults@psark007.github.io"
install -d -m 0755 "$target"
for name in backend.py extension.js metadata.json stylesheet.css; do
    install -m 0644 "$source_dir/$name" "$target/$name"
done
echo "Installed extension code at $target"
echo 'Log out and back in if needed, then enable: gnome-extensions enable local-vaults@psark007.github.io'
echo 'No vault was opened.'
