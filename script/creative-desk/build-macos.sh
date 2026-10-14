#!/bin/bash
set -euo pipefail

# Uses the repository's installed tools; never downloads a bundler or dependencies.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="$ROOT/target/creative-desk-macos"
APP="$OUTPUT/Creative Desk.app"
INSTALL=false
case "${1:-}" in
  '') ;;
  --install) INSTALL=true ;;
  *) echo 'Usage: build-macos.sh [--install]' >&2; exit 2 ;;
esac
[[ "$(uname -s)" == Darwin && "$(uname -m)" == x86_64 ]] || {
  echo 'This package is intended for an Intel Mac.' >&2; exit 1;
}
[[ -x "$ROOT/frontend/node_modules/.bin/vite" ]] || {
  echo 'Existing frontend dependencies are required; this script does not install them.' >&2; exit 1;
}
cd "$ROOT/frontend"
./node_modules/.bin/vite build --config apps/creative-desk/vite.config.ts
cd "$ROOT"
cargo build -p creative_desk --release --features custom-protocol
/usr/bin/lipo target/release/creative_desk -verify_arch x86_64

# Refuse an unrelated bundle, including a symlink, in either destination.
check_destination() {
  local destination="$1"
  [[ ! -L "$destination" ]] || { echo "Refusing symlink: $destination" >&2; exit 1; }
  if [[ -e "$destination" ]]; then
    [[ -d "$destination" && ! -L "$destination/Contents" && ! -L "$destination/Contents/Info.plist" ]] || exit 1
    [[ -z "$(find "$destination" -type l -print -quit)" ]] || { echo "Refusing bundle containing symlinks: $destination" >&2; exit 1; }
    local identifier
    identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null)" || exit 1
    [[ "$identifier" == local.creative.desk ]] || { echo "Refusing unrelated bundle: $destination" >&2; exit 1; }
  fi
}
check_destination "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/creative_desk "$APP/Contents/MacOS/creative_desk"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Creative Desk</string>
  <key>CFBundleDisplayName</key><string>Creative Desk</string>
  <key>CFBundleIdentifier</key><string>local.creative.desk</string>
  <key>CFBundleExecutable</key><string>creative_desk</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
mkdir -p "$APP/Contents/Resources/Licenses"
for notice in LICENSE-MIT LICENSE-APACHE NOTICE; do
  if [[ -f "$ROOT/$notice" ]]; then
    cp "$ROOT/$notice" "$APP/Contents/Resources/Licenses/$notice"
  else
    # Sparse checkouts may omit these tracked root files.
    git show "HEAD:$notice" > "$APP/Contents/Resources/Licenses/$notice"
  fi
done
head -n 3 "$ROOT/frontend/node_modules/three/examples/jsm/libs/ammo.wasm.js" > "$APP/Contents/Resources/Licenses/NOTICE-ammo.txt"
cp "$ROOT/frontend/node_modules/three/LICENSE" "$APP/Contents/Resources/Licenses/LICENSE-three.txt"
cp "$ROOT/frontend/apps/creative-desk/dist/resources/fonts/LICENSE-three-fonts.txt" "$APP/Contents/Resources/Licenses/"
/usr/bin/plutil -lint "$APP/Contents/Info.plist"
/usr/bin/codesign --force --sign - "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"
printf 'Built: %s\n' "$APP"
if $INSTALL; then
  DESTINATION='/Applications/Creative Desk.app'
  if [[ ! -w /Applications ]]; then
    mkdir -p "$HOME/Applications"
    DESTINATION="$HOME/Applications/Creative Desk.app"
  fi
  check_destination "$DESTINATION"
  /usr/bin/ditto "$APP" "$DESTINATION"
  /usr/bin/codesign --verify --deep --strict "$DESTINATION"
  printf 'Installed: %s\n' "$DESTINATION"
fi
