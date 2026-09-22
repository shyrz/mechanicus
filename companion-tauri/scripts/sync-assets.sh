#!/usr/bin/env bash
# Copies the companion sprite sheets into the Tauri frontend so the webview can
# load them with a plain <img>/background-image.
#
# The originals stay the single source of truth in `companion/animations/`;
# this directory is generated and should not be edited by hand.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
src="$root/companion/animations"
dest="$here/../ui/assets"

if [ ! -d "$src" ]; then
  echo "missing source directory: $src" >&2
  exit 1
fi

mkdir -p "$dest"
count=0
for sheet in "$src"/*.jpg; do
  [ -e "$sheet" ] || continue
  cp -f "$sheet" "$dest/"
  count=$((count + 1))
done

echo "synced $count sprite sheets -> $dest"
