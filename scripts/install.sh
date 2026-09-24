#!/bin/sh
# Jarhead installer — https://jarhead.kevinliu.studio/install.sh
#
#   curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh
#
# Clones github.com/Kevin-Liu-01/Jarhead to ~/jarhead (or $JARHEAD_DIR), builds the Swift
# helper and the app, installs /Applications/Jarhead.app in place, and opens it. Setup then
# asks for your name, the OpenAI key (written to ~/.jarhead/env, mode 600, by the app and
# never by this script), the brain, the permissions and the wake word.
#
# It runs only on macOS 14 or newer on Apple silicon. It installs nothing system-wide on its
# own: when Xcode's command line tools, Node 24 or pnpm are missing it prints the one command
# that fixes it and stops. Run it again any time: an existing checkout is pulled and rebuilt.
#
#   JARHEAD_DIR=~/src/jarhead   where to clone (default ~/jarhead)
#   JARHEAD_REF=main            the branch or tag to check out (default main)
#   JARHEAD_NO_OPEN=1           build and install, do not open the app
#
# The whole script is a function called on the last line, so a download cut short runs nothing.

set -eu

REPO_URL="https://github.com/Kevin-Liu-01/Jarhead.git"
DIR="${JARHEAD_DIR:-$HOME/jarhead}"
REF="${JARHEAD_REF:-main}"
NODE_MAJOR_MIN=24

say() { printf 'jarhead: %s\n' "$*"; }
fail() { printf 'jarhead: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

check_mac() {
  [ "$(uname -s)" = "Darwin" ] || fail "Jarhead runs on macOS only."
  case "$(uname -m)" in
    arm64) ;;
    *) fail "Jarhead needs Apple silicon (this Mac reports $(uname -m))." ;;
  esac
  major="$(sw_vers -productVersion | cut -d. -f1)"
  [ "${major:-0}" -ge 14 ] || fail "Jarhead needs macOS 14 or newer (this Mac runs $(sw_vers -productVersion))."
  say "macOS $(sw_vers -productVersion) on Apple silicon."
}

check_xcode() {
  if ! xcode-select -p >/dev/null 2>&1; then
    say "Xcode's command line tools are missing. Install them, then run this again:"
    say "  xcode-select --install"
    exit 1
  fi
  if ! xcrun --find swift >/dev/null 2>&1; then
    fail "swift is not on this Mac's toolchain; install Xcode or its command line tools (xcode-select --install) and run this again."
  fi
  say "Swift: $(xcrun swift --version 2>/dev/null | head -1)"
}

check_node() {
  if ! have node; then
    say "Node ${NODE_MAJOR_MIN} or newer is needed. One of these, then run this again:"
    say "  brew install node          (Homebrew)"
    say "  nvm install ${NODE_MAJOR_MIN}             (nvm)"
    say "  https://nodejs.org         (the installer)"
    exit 1
  fi
  v="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${v:-0}" -lt "$NODE_MAJOR_MIN" ]; then
    say "Node $(node -v) is too old; Jarhead needs ${NODE_MAJOR_MIN} or newer. Upgrade, then run this again:"
    say "  brew upgrade node   or   nvm install ${NODE_MAJOR_MIN}"
    exit 1
  fi
  say "Node $(node -v) at $(command -v node)."
}

check_pnpm() {
  if have pnpm; then
    say "pnpm $(pnpm -v)."
    return
  fi
  # corepack ships with Node; the repo pins the pnpm version in package.json (packageManager).
  if have corepack && corepack enable >/dev/null 2>&1 && have pnpm; then
    say "pnpm $(pnpm -v) through corepack."
    return
  fi
  say "pnpm is needed. One of these, then run this again:"
  say "  corepack enable            (ships with Node; may need sudo for a Homebrew Node)"
  say "  npm install -g pnpm@10"
  exit 1
}

fetch() {
  if [ -d "$DIR/.git" ]; then
    origin="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
    case "$origin" in
      *Kevin-Liu-01/Jarhead*) ;;
      *) fail "$DIR is a git checkout of something else ($origin); set JARHEAD_DIR to another folder." ;;
    esac
    say "Updating $DIR ($REF)."
    git -C "$DIR" fetch --quiet origin "$REF"
    git -C "$DIR" checkout --quiet "$REF"
    git -C "$DIR" pull --quiet --ff-only origin "$REF"
  elif [ -e "$DIR" ]; then
    fail "$DIR exists and is not a git checkout; move it or set JARHEAD_DIR to another folder."
  else
    say "Cloning Jarhead to $DIR."
    git clone --quiet --branch "$REF" "$REPO_URL" "$DIR"
  fi
  say "At $(git -C "$DIR" rev-parse --short HEAD)."
}

build() {
  cd "$DIR"
  say "Installing dependencies (pnpm install)."
  pnpm install --frozen-lockfile
  say "Building the Swift helper (pnpm build:hands)."
  pnpm build:hands
  say "Building, signing and installing /Applications/Jarhead.app (pnpm build:mac)."
  pnpm build:mac
}

finish() {
  say ""
  say "Installed /Applications/Jarhead.app from $DIR."
  say "Setup opens on first launch: your name, the OpenAI key for the voice (written to ~/.jarhead/env by the app),"
  say "the brain (Codex, Claude Code, an API key or a local model), the sixteen permissions, the wake word."
  say "Then say \"jarhead\", pass Touch ID, talk."
  say ""
  say "Signing: the build prints the identity it used. Ad-hoc resets the permission grants on every rebuild;"
  say "a self-signed Code Signing certificate in Keychain Access keeps them. Check with: cd $DIR && pnpm run doctor"
  if [ "${JARHEAD_NO_OPEN:-0}" != "1" ]; then
    say "Opening Jarhead."
    open -a Jarhead || say "Could not open the app; open /Applications/Jarhead.app yourself."
  fi
}

main() {
  say "Installing Jarhead."
  check_mac
  check_xcode
  check_node
  check_pnpm
  have git || fail "git is missing; it comes with Xcode's command line tools (xcode-select --install)."
  fetch
  build
  finish
}

main "$@"
