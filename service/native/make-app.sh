#!/usr/bin/env bash
# Build transcript-capture and wrap it into an .app bundle.
#
#   ./make-app.sh
#
# The bundle exists so macOS attributes the Screen Recording permission to a
# stable app, not to whichever terminal happened to launch OpenCode. The bundle
# is ad-hoc codesigned so the permission grant survives a rebuild.
set -euo pipefail

cd "$(dirname "$0")"

# The Command Line Tools toolchain lacks the SwiftUI macros plugin that
# WhisperKit's dependency graph needs, so builds fail there. Use full Xcode.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d "/Applications/Xcode-27.0.0-Beta.4.app/Contents/Developer" ]; then
  export DEVELOPER_DIR="/Applications/Xcode-27.0.0-Beta.4.app/Contents/Developer"
fi

APP="Transcript Capture.app"
MACOS="$APP/Contents/MacOS"

echo "Building release..."
swift build -c release

echo "Assembling ${APP}..."
rm -rf "$APP"
mkdir -p "$MACOS" "$APP/Contents/Resources"
cp ".build/release/transcript-capture" "$MACOS/transcript-capture"
cp "Sources/transcript-capture/Info.plist" "$APP/Contents/Info.plist"

echo "Codesigning (ad-hoc)..."
# Do NOT enable the hardened runtime here. Under the hardened runtime, the
# protected resources (Microphone, Screen Recording) need matching entitlements
# or macOS silently denies them instead of showing the permission prompt.
codesign --force --sign - "$APP" >/dev/null

echo "Done. Binary at: $MACOS/transcript-capture"
