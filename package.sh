#!/bin/sh
# Builds the zip to upload to the Chrome Web Store: store/hourglass-<version>.zip
# Raise "version" in manifest.json before running it for an update.
cd "$(dirname "$0")" || exit 1
VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json)
rm -f "store/hourglass-$VERSION.zip"
mkdir -p store
zip -qr "store/hourglass-$VERSION.zip" manifest.json background.js popup pill shared fonts icons README.md -x '*.DS_Store'
echo "Built store/hourglass-$VERSION.zip"
