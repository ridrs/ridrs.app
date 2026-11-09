#!/usr/bin/env bash
# Builds the icons of every ridrs app (native, companion) from the sources in this folder.
# Run from the repository root: scripts/app-icon/generate.sh
#
# icon.svg is the desktop icon (macOS tile with margin; also Windows and the Android legacy icon),
# the android-*.svg files are the layers of the Android adaptive and themed icons, and ios.svg is
# the full-bleed iOS icon (iOS rounds the corners itself).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
for app in native companion; do
  pnpm --filter "@ridrs/$app" exec tauri icon "$here/app-icon.json"
  ios="$(mktemp -d)"
  pnpm --filter "@ridrs/$app" exec tauri icon "$here/ios.json" -o "$ios" >/dev/null
  root="$(pnpm --filter "@ridrs/$app" exec pwd)/src-tauri"
  cp "$ios"/ios/*.png "$root/icons/ios/"
  # The generated Xcode project (ignored by Git) keeps its own copy, when it exists.
  if [ -d "$root/gen/apple/Assets.xcassets/AppIcon.appiconset" ]; then
    cp "$ios"/ios/*.png "$root/gen/apple/Assets.xcassets/AppIcon.appiconset/"
  fi
  rm -rf "$ios"
done
