/**
 * Make the Linux installer script for the AppImage `npm run dist:linux` just built.
 *
 *   node scripts/linux-sh.js        (npm runs it at the end of dist:linux)
 *
 * Writes release/VoxAI-Coder-<version>-Linux.sh: one file somebody downloads and runs with
 * `bash`. It fetches THAT version's AppImage from the public releases feed, checks it against
 * the SHA-512 written into the script here, installs it under ~/.local, adds a menu entry with
 * the app's icon, and starts it. After that the app updates itself (update-linux.json), so the
 * script is only ever needed once. Each release carries one next to its Windows .exe.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FEED } = require('../src/main/updater.js');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.VOX_RELEASE_OUT || path.join(ROOT, 'release');
const { version } = require(path.join(ROOT, 'package.json'));
const file = `VoxAI-Coder-${version}.AppImage`;
const appimage = path.join(OUT, file);

const die = (msg) => { console.error('linux-sh: ' + msg); process.exit(1); };
if (!fs.existsSync(appimage)) die(`${appimage} is missing; build it first (npm run dist:linux)`);
const bytes = fs.readFileSync(appimage);
if (bytes.length < 20 * 1024 * 1024) die(`${file} is only ${bytes.length} bytes, far too small to be the app`);
const sha512 = crypto.createHash('sha512').update(bytes).digest('hex');

const script = `#!/usr/bin/env bash
# VoxAI Coder ${version} for Linux.
#
#   bash VoxAI-Coder-${version}-Linux.sh              install and start it
#   bash VoxAI-Coder-${version}-Linux.sh --no-start   install only
#   bash VoxAI-Coder-${version}-Linux.sh --uninstall  remove it (your sessions and settings stay)
#
# Downloads the AppImage for this version, checks its SHA-512, installs it for you alone
# (no sudo) under ~/.local, and adds VoxAI Coder to your applications menu. After this the
# app keeps itself up to date.
set -euo pipefail

VERSION='${version}'
FILE='${file}'
URL='${FEED}/${encodeURIComponent(file)}'
SIZE=${bytes.length}
SHA512='${sha512}'

APP_DIR="\${XDG_DATA_HOME:-$HOME/.local/share}/voxai-coder"
BIN_DIR="$HOME/.local/bin"
MENU_DIR="\${XDG_DATA_HOME:-$HOME/.local/share}/applications"
APP="$APP_DIR/VoxAI-Coder.AppImage"

say() { printf '%s\\n' "$*"; }
fail() { printf 'VoxAI Coder: %s\\n' "$*" >&2; exit 1; }

if [ "\${1:-}" = "--uninstall" ]; then
  rm -f "$APP" "$APP_DIR/icon.png" "$BIN_DIR/voxai-coder" "$MENU_DIR/voxai-coder.desktop"
  rmdir "$APP_DIR" 2>/dev/null || true
  say "VoxAI Coder is removed. Your sessions and settings are still in ~/.config/voxai-coder."
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || fail "this installer is for Linux."
case "$(uname -m)" in x86_64|amd64) ;; *) fail "VoxAI Coder is built for 64-bit Intel/AMD (x86_64); this machine is $(uname -m)." ;; esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading VoxAI Coder $VERSION ($((SIZE / 1048576)) MB)..."
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --progress-bar -o "$TMP/$FILE" "$URL" || fail "the download failed. Check your connection and run this again."
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress -O "$TMP/$FILE" "$URL" || fail "the download failed. Check your connection and run this again."
else
  fail "neither curl nor wget is installed; install one of them and run this again."
fi

say "Checking it..."
GOT="$(sha512sum "$TMP/$FILE" | cut -d' ' -f1)"
[ "$GOT" = "$SHA512" ] || fail "the download does not match VoxAI Coder $VERSION (checksum differs), so it was not installed."

mkdir -p "$APP_DIR" "$BIN_DIR" "$MENU_DIR"
install -m 755 "$TMP/$FILE" "$APP"
ln -sf "$APP" "$BIN_DIR/voxai-coder"

# The icon, from inside the AppImage (unpacking needs no FUSE).
( cd "$TMP" && "$APP" --appimage-extract .DirIcon >/dev/null 2>&1 && cp -L squashfs-root/.DirIcon "$APP_DIR/icon.png" ) || true

cat > "$MENU_DIR/voxai-coder.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=VoxAI Coder
Comment=Desktop coding agent for OpenRouter and local models
Exec="$APP" %U
Icon=$APP_DIR/icon.png
Terminal=false
Categories=Development;
StartupWMClass=VoxAI Coder
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$MENU_DIR" >/dev/null 2>&1 || true

say "Installed VoxAI Coder $VERSION: it is in your applications menu, and 'voxai-coder' runs it from a terminal."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "(Add $BIN_DIR to your PATH to run 'voxai-coder' from a terminal.)" ;; esac

# AppImages run through FUSE 2. Without it they do not start, and the message they give is cryptic.
if ! ( ldconfig -p 2>/dev/null | grep -q 'libfuse\\.so\\.2' ); then
  say ""
  say "Note: your system seems to be missing FUSE 2, which AppImages need to start."
  say "  Debian/Ubuntu: sudo apt install libfuse2   (Ubuntu 24.04+: libfuse2t64)"
  say "  Fedora:        sudo dnf install fuse-libs"
  say "  Arch:          sudo pacman -S fuse2"
fi

if [ "\${1:-}" != "--no-start" ]; then
  say "Starting VoxAI Coder..."
  nohup "$APP" >/dev/null 2>&1 &
fi
`;

const out = path.join(OUT, `VoxAI-Coder-${version}-Linux.sh`);
fs.writeFileSync(out, script.replace(/\r\n/g, '\n'), { mode: 0o755 });
console.log(`wrote ${path.basename(out)} for ${file} (${(bytes.length / 1048576).toFixed(0)} MB)`);
