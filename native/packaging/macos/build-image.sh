#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
package="${1:?Pass the staged native package directory}"
output="${2:?Pass the output disk image path}"
scratch="$(mktemp -d)"
trap 'rm -r "$scratch"' EXIT
bundle="$scratch/image/Apolloon Telsysteem.app/Contents"
mkdir -p "$bundle"/{MacOS,Resources} "$scratch/Apolloon.iconset"
cp -R "$package"/. "$bundle/MacOS/"
cp native/packaging/macos/Info.plist "$bundle/Info.plist"
version="${APOLLOON_APP_VERSION:-$(awk -F '"' '/^version = / { print $2; exit }' native/Cargo.toml)}"
plutil -replace CFBundleShortVersionString -string "${version%%-*}" "$bundle/Info.plist"
plutil -replace CFBundleVersion -string "${version%%-*}" "$bundle/Info.plist"
plutil -lint "$bundle/Info.plist"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" build/icon.png --out "$scratch/Apolloon.iconset/icon_${size}x${size}.png" >/dev/null
    retina=$((size * 2))
    sips -z "$retina" "$retina" build/icon.png --out "$scratch/Apolloon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns -o "$bundle/Resources/Apolloon.icns" "$scratch/Apolloon.iconset"
ln -s /Applications "$scratch/image/Applications"
hdiutil create -volname "Apolloon Telsysteem" -srcfolder "$scratch/image" -format UDZO -ov "$output"
