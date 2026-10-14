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
# Stage and destination share a filesystem, so the final move does not merge.
# Keep the previous bundle intact, including files unknown to this script.
replace_bundle() {
  local source="$1" destination="$2" backup_app=''
  check_destination "$destination"
  if [[ -e "$destination" ]]; then
    local backup_directory
    backup_directory="$(mktemp -d "${destination%/*}/.creative-desk-backup.XXXXXX")"
    backup_app="$backup_directory/Creative Desk.app"
    mv "$destination" "$backup_app"
    printf 'Preserved previous bundle: %s\n' "$backup_app"
  fi
  if ! mv "$source" "$destination"; then
    if [[ -n "$backup_app" && ! -e "$destination" && ! -L "$destination" ]]; then
      mv "$backup_app" "$destination"
    fi
    return 1
  fi
}

[[ ! -L "$OUTPUT" ]] || { echo "Refusing symlink: $OUTPUT" >&2; exit 1; }
check_destination "$APP"
if $INSTALL; then
  DESTINATION='/Applications/Creative Desk.app'
  if [[ ! -w /Applications ]]; then
    DESTINATION="$HOME/Applications/Creative Desk.app"
  fi
  check_destination "$DESTINATION"
fi

cd "$ROOT/frontend"
./node_modules/.bin/vite build --config apps/creative-desk/vite.config.ts
cd "$ROOT"
cargo build -p creative_desk --release --features custom-protocol
/usr/bin/lipo target/release/creative_desk -verify_arch x86_64

mkdir -p "$OUTPUT"
STAGE_DIRECTORY="$(mktemp -d "$OUTPUT/.creative-desk-stage.XXXXXX")"
STAGED_APP="$STAGE_DIRECTORY/Creative Desk.app"
mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources"
cp target/release/creative_desk "$STAGED_APP/Contents/MacOS/creative_desk"
cat > "$STAGED_APP/Contents/Info.plist" <<'PLIST'
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
mkdir -p "$STAGED_APP/Contents/Resources/Licenses"
for notice in LICENSE-MIT LICENSE-APACHE NOTICE; do
  if [[ -f "$ROOT/$notice" ]]; then
    cp "$ROOT/$notice" "$STAGED_APP/Contents/Resources/Licenses/$notice"
  else
    # Sparse checkouts may omit these tracked root files.
    git show "HEAD:$notice" > "$STAGED_APP/Contents/Resources/Licenses/$notice"
  fi
done
head -n 3 "$ROOT/frontend/node_modules/three/examples/jsm/libs/ammo.wasm.js" > "$STAGED_APP/Contents/Resources/Licenses/NOTICE-ammo.txt"
cp "$ROOT/frontend/node_modules/three/LICENSE" "$STAGED_APP/Contents/Resources/Licenses/LICENSE-three.txt"
cp "$ROOT/frontend/apps/creative-desk/dist/resources/fonts/LICENSE-three-fonts.txt" "$STAGED_APP/Contents/Resources/Licenses/"
/usr/bin/plutil -lint "$STAGED_APP/Contents/Info.plist"
/usr/bin/codesign --force --sign - "$STAGED_APP"
/usr/bin/codesign --verify --deep --strict "$STAGED_APP"
replace_bundle "$STAGED_APP" "$APP"
printf 'Built: %s\n' "$APP"
if $INSTALL; then
  mkdir -p "${DESTINATION%/*}"
  INSTALL_STAGE_DIRECTORY="$(mktemp -d "${DESTINATION%/*}/.creative-desk-stage.XXXXXX")"
  INSTALL_STAGED_APP="$INSTALL_STAGE_DIRECTORY/Creative Desk.app"
  /usr/bin/ditto "$APP" "$INSTALL_STAGED_APP"
  /usr/bin/codesign --verify --deep --strict "$INSTALL_STAGED_APP"
  replace_bundle "$INSTALL_STAGED_APP" "$DESTINATION"
  /usr/bin/codesign --verify --deep --strict "$DESTINATION"
  printf 'Installed: %s\n' "$DESTINATION"
fi
