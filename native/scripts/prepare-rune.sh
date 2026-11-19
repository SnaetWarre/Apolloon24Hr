#!/usr/bin/env bash
set -euo pipefail

native_dir=$(cd "$(dirname "$0")/.." && pwd)
patch_dir="$native_dir/patches/rune"
source_dir="$native_dir/.rune"
revision=$(<"$patch_dir/revision")
patch_hash=$(git hash-object "$patch_dir/apolloon.patch")
stamp="$revision $patch_hash"

if [[ -f "$source_dir/.apolloon-revision" && $(<"$source_dir/.apolloon-revision") == "$stamp" ]]; then
  exit 0
fi

if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a full Rune Git commit in $patch_dir/revision" >&2
  exit 1
fi

scratch=$(mktemp -d "$native_dir/.rune-prepare.XXXXXX")
lock="$native_dir/.rune-prepare.lock"
locked=false
cleanup() {
  if [[ "$locked" == true ]]; then
    if [[ ! -e "$source_dir" && -d "$scratch/previous" ]]; then
      mv "$scratch/previous" "$source_dir"
    fi
    rmdir "$lock"
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir "$scratch/.rune"

curl --fail --location --silent --show-error --retry 3 \
  --output "$scratch/upstream.tar.gz" \
  "https://codeload.github.com/anomalyco/rune/tar.gz/$revision"
# Give refreshed path dependencies new mtimes so Cargo rebuilds them after a pin change.
tar -xmzf "$scratch/upstream.tar.gz" --strip-components=1 -C "$scratch/.rune"

# Apply inside the staged checkout, independently of the containing Apolloon repository.
git -C "$scratch/.rune" init -q
git -C "$scratch/.rune" -c apply.whitespace=nowarn apply "$patch_dir/apolloon.patch"
rm -rf "$scratch/.rune/.git"
printf '%s\n' "$stamp" > "$scratch/.rune/.apolloon-revision"

# Serialize publication. Downloads and patch failures leave the current source intact.
for ((attempt = 0; attempt < 100; attempt++)); do
  if mkdir "$lock" 2>/dev/null; then
    locked=true
    break
  fi
  sleep 0.1
done
if [[ "$locked" != true ]]; then
  echo "Could not acquire the Rune source lock at $lock" >&2
  exit 1
fi
if [[ -f "$source_dir/.apolloon-revision" && $(<"$source_dir/.apolloon-revision") == "$stamp" ]]; then
  exit 0
fi
if [[ -d "$source_dir" ]]; then
  mv "$source_dir" "$scratch/previous"
fi
mv "$scratch/.rune" "$native_dir/"
