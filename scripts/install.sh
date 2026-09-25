#!/bin/sh
# Jarhead installer · https://jarhead.kevinliu.studio/install.sh
#
#   curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh
#
# Clones github.com/Kevin-Liu-01/Jarhead to ~/jarhead (or $JARHEAD_DIR) and runs the README's four
# commands, in order: pnpm install · pnpm build:hands · pnpm build:mac · open -a Jarhead. The app's
# Setup then asks for your name, the OpenAI key for the voice (Setup writes it to ~/.jarhead/env,
# mode 0600; this script never touches that file), the brain, the sixteen permissions and the wake
# word. Then say "jarhead", pass Touch ID, talk.
#
# It runs only on macOS 14 or newer on Apple silicon. It prints its plan before it starts, never
# uses sudo, never removes anything and installs nothing system-wide: when Xcode's command line
# tools, Node 24 or pnpm are missing it prints the command that fixes it and stops. Run it again any
# time: an existing checkout is pulled and rebuilt.
#
#   JARHEAD_DIR=~/src/jarhead   where to clone (default ~/jarhead)
#   JARHEAD_REF=main            the branch or tag to check out (default main)
#   JARHEAD_NO_OPEN=1           build and install, do not open the app
#   JARHEAD_DRY_RUN=1           print every step and every command, run none of them
#
# The whole script is one function called on the last line, so a download cut short runs nothing.

set -eu

REPO_URL="https://github.com/Kevin-Liu-01/Jarhead.git"
DIR="${JARHEAD_DIR:-$HOME/jarhead}"
REF="${JARHEAD_REF:-main}"
DRY="${JARHEAD_DRY_RUN:-0}"
NODE_MAJOR_MIN=24

say() { printf 'jarhead: %s\n' "$*"; }
fail() { printf 'jarhead: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
dry() { [ "$DRY" = "1" ]; }

# Every command that changes something goes through run: it is announced on its own jarhead: line
# first, and under JARHEAD_DRY_RUN=1 it is only announced.
run() {
  say "\$ $*"
  if dry; then return 0; fi
  "$@"
}

plan() {
  say "The plan:"
  say "  1  check macOS 14+ on Apple silicon, Xcode's command line tools, Node ${NODE_MAJOR_MIN}+, pnpm 10 and git"
  if [ -d "$DIR/.git" ]; then
    say "  2  pull $DIR ($REF)"
  else
    say "  2  git clone $REPO_URL $DIR ($REF)"
  fi
  say "  3  pnpm install"
  say "  4  pnpm build:hands"
  say "  5  pnpm build:mac"
  if [ "${JARHEAD_NO_OPEN:-0}" = "1" ]; then
    say "  6  the app stays closed (JARHEAD_NO_OPEN=1)"
  else
    say "  6  open -a Jarhead"
  fi
  say "It never writes ~/.jarhead/env, never uses sudo, never removes anything, installs nothing system-wide, and stops at the first failed check."
  if dry; then say "Dry run: every step is printed, none is run."; fi
}

check_mac() {
  [ "$(uname -s)" = "Darwin" ] || fail "Jarhead runs on macOS only."
  case "$(uname -m)" in
    arm64) ;;
    *) fail "Jarhead needs Apple silicon (this Mac reports $(uname -m))." ;;
  esac
  version="$(sw_vers -productVersion)"
  major="${version%%.*}"
  case "$major" in
    ''|*[!0-9]*) fail "Could not read the macOS version (sw_vers said '$version')." ;;
  esac
  [ "$major" -ge 14 ] || fail "Jarhead needs macOS 14 or newer (this Mac runs $version)."
  say "macOS $version on Apple silicon."
}

check_xcode() {
  if ! xcode-select -p >/dev/null 2>&1; then
    say "Xcode's command line tools are missing. Install them, then run this again:"
    say "  xcode-select --install"
    exit 1
  fi
  if ! xcrun --find swift >/dev/null 2>&1; then
    say "swift is not on this Mac's toolchain. Install Xcode 15.3 or newer, or its command line tools, then run this again:"
    say "  xcode-select --install"
    exit 1
  fi
  say "Swift: $(xcrun swift --version 2>/dev/null | head -1)"
}

check_node() {
  if ! have node; then
    if [ -d "$HOME/.nvm" ]; then
      say "~/.nvm exists but node is not on PATH in this shell. Open a new terminal, or: . ~/.nvm/nvm.sh && nvm use ${NODE_MAJOR_MIN}"
    fi
    say "Node ${NODE_MAJOR_MIN} or newer is needed. One of these, then run this again:"
    say "  brew install node          (Homebrew)"
    say "  nvm install ${NODE_MAJOR_MIN}             (nvm)"
    say "  https://nodejs.org         (the installer)"
    exit 1
  fi
  v="$(node -v | sed 's/^v//' | cut -d. -f1)"
  case "$v" in
    ''|*[!0-9]*) fail "Could not read the Node version (node -v said '$(node -v)')." ;;
  esac
  if [ "$v" -lt "$NODE_MAJOR_MIN" ]; then
    say "Node $(node -v) is too old; Jarhead needs ${NODE_MAJOR_MIN} or newer. One of these, then run this again:"
    say "  brew upgrade node          (Homebrew)"
    say "  nvm install ${NODE_MAJOR_MIN}             (nvm)"
    say "  https://nodejs.org         (the installer)"
    exit 1
  fi
  say "Node $(node -v) at $(command -v node)."
}

check_pnpm() {
  if have pnpm; then
    say "pnpm $(pnpm -v)."
    return 0
  fi
  if have corepack; then
    say "pnpm is missing; corepack ships with Node, and the repo pins pnpm 10 in package.json (packageManager)."
    if run corepack enable; then
      if dry; then say "pnpm would come from corepack."; return 0; fi
      if have pnpm; then say "pnpm $(pnpm -v) through corepack."; return 0; fi
    fi
  fi
  say "pnpm 10 is needed. One of these, then run this again:"
  say "  corepack enable            (ships with Node)"
  say "  npm install -g pnpm@10"
  exit 1
}

check_git() {
  have git || fail "git is missing; it comes with Xcode's command line tools (xcode-select --install)."
  say "git $(git --version | sed 's/^git version //')."
}

fetch() {
  if [ -d "$DIR/.git" ]; then
    origin="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
    case "$origin" in
      *Kevin-Liu-01/Jarhead*) ;;
      *) fail "$DIR is a git checkout of something else ($origin); set JARHEAD_DIR to another folder." ;;
    esac
    say "Updating $DIR ($REF)."
    run git -C "$DIR" fetch --quiet origin "$REF"
    run git -C "$DIR" checkout --quiet "$REF"
    run git -C "$DIR" pull --quiet --ff-only origin "$REF"
  elif [ -e "$DIR" ]; then
    fail "$DIR exists and is not a git checkout; move it or set JARHEAD_DIR to another folder."
  else
    say "Cloning Jarhead to $DIR."
    run git clone --quiet --branch "$REF" "$REPO_URL" "$DIR"
  fi
  if ! dry; then say "At $(git -C "$DIR" rev-parse --short HEAD)."; fi
}

build() {
  if dry; then say "In $DIR:"; else cd "$DIR"; fi
  say "Installing dependencies."
  run pnpm install
  say "Building the Swift helper (build/jarhead-hands)."
  run pnpm build:hands
  say "Building, signing and installing /Applications/Jarhead.app in place."
  run pnpm build:mac
}

finish() {
  if dry; then
    say "That would install /Applications/Jarhead.app from $DIR."
  else
    say "Installed /Applications/Jarhead.app from $DIR."
  fi
  say "Setup opens on first launch, seven steps: Welcome (your name), Voice (the OpenAI key, written to ~/.jarhead/env by the app),"
  say "Brain (Codex, Claude Code, an API key or a local model), Permissions (sixteen, the seven required first), Wake, Agents, Done."
  say "Then say \"jarhead\", pass Touch ID, talk."
  say "Signing: pnpm build:mac prints the identity it used. Ad-hoc resets the permission grants on every rebuild;"
  say "a self-signed Code Signing certificate from Keychain Access keeps them. Check with: cd $DIR && pnpm run doctor"
  if [ "${JARHEAD_NO_OPEN:-0}" != "1" ]; then
    say "Opening Jarhead."
    run open -a Jarhead || say "Could not open the app; open /Applications/Jarhead.app yourself."
  fi
}

main() {
  say "Installing Jarhead."
  plan
  check_mac
  check_xcode
  check_node
  check_pnpm
  check_git
  fetch
  build
  finish
}

main "$@"
