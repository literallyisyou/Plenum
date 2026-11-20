#!/usr/bin/env bash
# Build one Apple Silicon disk image, then install and smoke-test that exact image.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This preview build and its tests require an Apple Silicon Mac.' >&2
  exit 2
fi

output_dir="${1:-release/mac-preview}"
if [[ -e "$output_dir" ]]; then
  echo "Use a new output directory. Already exists: $output_dir" >&2
  exit 2
fi

npm run check
npm test
npm run stamp
npm run legal
npm run mobile:build

# Ad hoc sign the private preview with the existing hardened runtime settings.
npx --no-install electron-builder --mac dmg --arm64 --publish never \
  "--config.directories.output=$output_dir" \
  --config.mac.identity=- --config.mac.notarize=false \
  --config.mac.entitlementsInherit=build/entitlements.mac.plist \
  --config.dmg.artifactName=Plenum-Apple-Silicon-Preview.dmg

image="$output_dir/Plenum-Apple-Silicon-Preview.dmg"
test -s "$image"
hdiutil verify "$image"
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}"/plenum-mac-preview.XXXXXXXX)"
mkdir "$scratch/mount" "$scratch/home"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$scratch/mount" || return
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

# Mount this build's own installer in the isolated test. The published image
# still presents its license when the recipient opens it.
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$scratch/mount" "$image" <<< Y
mounted=true
ditto "$scratch/mount/Plenum.app" "$scratch/Plenum.app"
hdiutil detach "$scratch/mount"
mounted=false

app="$scratch/Plenum.app"
binary="$app/Contents/MacOS/Plenum"
resources="$app/Contents/Resources/app"
test "$(lipo -archs "$binary")" = arm64
codesign --verify --deep --strict --verbose=2 "$app"
for file in server.mjs public/app.js public/assistant-content.js LICENSE.txt THIRD-PARTY-NOTICES.txt legal/EULA.txt; do
  test -s "$resources/$file"
done

# Load the actual ARM native dependency using the packaged Electron runtime.
# No accessibility or screen recording permission is needed for this check.
/usr/bin/env -i HOME="$scratch/home" PATH=/usr/bin:/bin \
  ELECTRON_RUN_AS_NODE=1 "$binary" -e \
  'if (process.platform !== "darwin" || process.arch !== "arm64") process.exit(1); require(require.resolve("koffi", { paths: [process.argv[1]] }));' \
  "$resources"

node scripts/smoke-packaged.mjs --exe "$binary" --root "$scratch/plain"
node scripts/smoke-packaged.mjs --exe "$binary" --crash --root "$scratch/recovery"
shasum -a 256 "$image"
