#!/bin/sh
# Build the macOS icon representations from the selected app-icon.png.
set -eu

icon_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
icon_tmp=$(mktemp -d "${TMPDIR:-/tmp}/act-app-icon.XXXXXX")
trap 'rm -rf "$icon_tmp"' EXIT HUP INT TERM
icon_set="$icon_tmp/app-icon.iconset"
mkdir "$icon_set"

for icon_size in 16 32 128 256 512; do
  sips -z "$icon_size" "$icon_size" "$icon_dir/app-icon.png" \
    --out "$icon_set/icon_${icon_size}x${icon_size}.png" >/dev/null
  retina_size=$((icon_size * 2))
  sips -z "$retina_size" "$retina_size" "$icon_dir/app-icon.png" \
    --out "$icon_set/icon_${icon_size}x${icon_size}@2x.png" >/dev/null
done

iconutil --convert icns --output "$icon_dir/app-icon.icns" "$icon_set"
