#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
package="${1:?Pass the staged native package directory}"
output="${2:?Pass the output disk image path}"
scratch="$(mktemp -d)"
trap 'rm -r "$scratch"' EXIT
app="$scratch/image/Apolloon Telsysteem.app"
bundle="$app/Contents"
mkdir -p "$bundle"/{MacOS,Resources} "$scratch/Apolloon.iconset"
cp "$package/apolloon-native" "$bundle/MacOS/"
cp -R "$package/web-dist" "$bundle/Resources/"
cp native/packaging/macos/Info.plist "$bundle/Info.plist"
version="${APOLLOON_APP_VERSION:-$(awk -F '"' '/^version = / { print $2; exit }' native/Cargo.toml)}"
plutil -replace CFBundleShortVersionString -string "${version%%-*}" "$bundle/Info.plist"
plutil -replace CFBundleVersion -string "${version%%-*}" "$bundle/Info.plist"
plutil -lint "$bundle/Info.plist"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" native/packaging/macos/icon.png --out "$scratch/Apolloon.iconset/icon_${size}x${size}.png" >/dev/null
    retina=$((size * 2))
    sips -z "$retina" "$retina" native/packaging/macos/icon.png --out "$scratch/Apolloon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns -o "$bundle/Resources/Apolloon.icns" "$scratch/Apolloon.iconset"
codesign --force --sign - "$app"
create-dmg \
    --volname "Apolloon Telsysteem" \
    --volicon "$bundle/Resources/Apolloon.icns" \
    --background native/packaging/macos/background.png \
    --window-size 600 250 \
    --icon-size 100 \
    --icon "Apolloon Telsysteem.app" 153 111 \
    --hide-extension "Apolloon Telsysteem.app" \
    --app-drop-link 447 111 \
    "$output" "$scratch/image"
