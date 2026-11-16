#!/bin/zsh
# Renames the dev Electron bundle to Warehouse and gives it the app icon, so the
# Dock and menu bar show Warehouse in `npm run dev`. Runs on postinstall; macOS only.
[[ "$(uname -s)" == Darwin ]] || exit 0
cd "${0:A:h}/.." || exit 1

BUNDLE=node_modules/electron/dist/Electron.app
PLIST=$BUNDLE/Contents/Info.plist
[[ -f $PLIST ]] || exit 0

/usr/libexec/PlistBuddy -c "Set :CFBundleName Warehouse" -c "Set :CFBundleDisplayName Warehouse" "$PLIST"

ICONSET=$(mktemp -d)/icon.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/electron.icns"

# Editing the bundle breaks Electron's ad-hoc signature; re-sign so it still launches.
codesign --force --deep --sign - "$BUNDLE" 2>/dev/null
touch "$BUNDLE"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$BUNDLE" 2>/dev/null
exit 0
