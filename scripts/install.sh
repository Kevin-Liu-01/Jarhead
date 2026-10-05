#!/bin/sh
# Jarhead installer · https://jarhead.kevinliu.studio/install.sh
#
#   curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh
#
# Clones github.com/Kevin-Liu-01/Jarhead to ~/jarhead (or $JARHEAD_DIR) and runs the README's four
# commands, in order: pnpm install · pnpm build:hands · pnpm build:mac · open -a Jarhead. The install
# leaves out the landing page's dependencies (--filter '!./site'); the app never uses them. The app's
# Setup then asks for your name, the OpenAI key for the voice (Setup writes it to ~/.jarhead/env,
# mode 0600; this script never touches that file), the brain, the sixteen permissions and the wake
# word. Then say "jarhead", pass Touch ID, talk.
#
# It runs only on macOS 14 or newer on Apple silicon. It prints its plan before it starts and stops
# at the first failed check. It never uses sudo. It installs none of the tools it needs: when Xcode's
# command line tools (Swift 6.0 or newer, from Xcode 16), Node 24 or pnpm 10 are missing or too old, it prints the
# command that fixes it and stops. Outside the checkout it installs one thing,
# /Applications/Jarhead.app, which pnpm build:mac updates in place. It signs with a code-signing
# certificate when the keychain has one. Without one it signs ad-hoc, which installs too; the
# permission grants then reset on every rebuild.
#
# Run it again any time. An existing checkout is fast-forwarded to origin. Commits of its own (a
# self-edit you applied) are rebased onto origin. Uncommitted changes, or commits that do not rebase
# cleanly, stop it with a line that says what to do, and the checkout is left as it was. The two
# icon strips a build redraws do not count as changes: they go back to the committed copies.
#
# Settings go on the sh side of the pipe:
#
#   curl -fsSL https://jarhead.kevinliu.studio/install.sh | JARHEAD_DIR=~/src/jarhead sh
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
PNPM_MAJOR_MIN=10

say() { printf 'jarhead: %s\n' "$*"; }
fail() { printf 'jarhead: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
dry() { [ "$DRY" = "1" ]; }
no_open() { [ "${JARHEAD_NO_OPEN:-0}" = "1" ]; }

# One argument the way it would have to be typed: bare when it is plain, else in single quotes.
quote() {
  case "$1" in
    '' | *[!A-Za-z0-9_./:=@%+,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Every command that changes something goes through run: it is announced on its own jarhead: line
# first, quoted so it can be pasted, and under JARHEAD_DRY_RUN=1 it is only announced. A command
# printed for you to type puts each argument through quote the same way.
run() {
  cmdline=""
  for arg in "$@"; do cmdline="$cmdline${cmdline:+ }$(quote "$arg")"; done
  say "\$ $cmdline"
  if dry; then return 0; fi
  "$@"
}

# The first line of a tool's output that is not blank, so a refusal can say what the tool said.
first_line() {
  line="$(printf '%s\n' "$1" | grep -m 1 '[^[:space:]]' || true)"
  printf '%s' "${line:-nothing}"
}

# A fresh Xcode whose license is not accepted fails every xcrun and the git shim, saying so on stderr.
stop_on_license() {
  case "$1" in
    *[Ll]icense*)
      say "Xcode's license is not accepted yet, so its tools refuse to run. Accept it, then run this again:"
      say "  sudo xcodebuild -license"
      exit 1
      ;;
  esac
}

plan() {
  say "The plan:"
  say "  1  check macOS 14+ on Apple silicon, Xcode's command line tools (Swift 6.0+), Node ${NODE_MAJOR_MIN}+, pnpm ${PNPM_MAJOR_MIN}+ and git"
  if [ -d "$DIR/.git" ]; then
    say "  2  update $DIR to origin's $REF (a fast-forward, or a rebase of its own commits)"
  else
    say "  2  git clone $REPO_URL $(quote "$DIR") ($REF)"
  fi
  say "  3  pnpm install (without the site's dependencies)"
  say "  4  pnpm build:hands"
  say "  5  pnpm build:mac"
  if no_open; then
    say "  6  the app stays closed (JARHEAD_NO_OPEN=1)"
  else
    say "  6  open -a Jarhead (if an older Jarhead is running, it asks you to quit and reopen it)"
  fi
  say "It never writes ~/.jarhead/env and never uses sudo. Outside the checkout it installs only /Applications/Jarhead.app. It stops at the first failed check."
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

# The app's SwiftUI needs the macOS 15 SDK (back-deployed to macOS 14), which comes with Xcode 16 and Swift 6.0,
# so an older Swift is refused here, before pnpm install. (Package.swift's swift-tools 5.10 is only the manifest's floor.)
check_xcode() {
  if ! xcode-select -p >/dev/null 2>&1; then
    say "Xcode's command line tools are missing. Install them, then run this again:"
    say "  xcode-select --install"
    exit 1
  fi
  if ! swift_path="$(xcrun --find swift 2>&1)"; then
    stop_on_license "$swift_path"
    say "swift is not on this Mac's toolchain. Install Xcode 16 or newer, or its command line tools, then run this again:"
    say "  xcode-select --install"
    exit 1
  fi
  # stderr is kept: when the version cannot be read, what xcrun said instead is the reason. On a
  # good toolchain stderr is only swift-driver's own version, printed ahead of the Swift line.
  swift_out="$(xcrun swift --version 2>&1 || true)"
  swift_line="$(printf '%s\n' "$swift_out" | grep 'Swift version' | head -n 1 | sed 's/^swift-driver version: [^ ]* //')"
  swift_version="$(printf '%s\n' "$swift_line" | sed -n 's/.*Swift version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
  case "$swift_version" in
    [0-9]*.[0-9]*) ;;
    *)
      stop_on_license "$swift_out"
      fail "Could not read the Swift version. xcrun swift --version said: $(first_line "$swift_out")"
      ;;
  esac
  swift_major="${swift_version%%.*}"
  swift_minor="${swift_version#*.}"
  if [ "$swift_major" -lt 6 ]; then
    say "Swift $swift_version is too old. Jarhead needs Swift 6.0 or newer, which comes with Xcode 16 or newer (Xcode 16 needs macOS 14.5 or later)."
    say "Update Xcode, or its command line tools in System Settings > General > Software Update, then run this again."
    exit 1
  fi
  say "Swift: $swift_line"
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

# pnpm is never installed here. npm comes first in the fix: Node 25 and newer ship no corepack.
check_pnpm() {
  if have pnpm; then
    # stderr is kept too: a corepack shim's notice or a broken install says why there is no version.
    pnpm_out="$(pnpm -v 2>&1 || true)"
    pnpm_version="$(printf '%s\n' "$pnpm_out" | grep -m 1 -E '^[0-9]+\.[0-9]+' || true)"
    pnpm_major="${pnpm_version%%.*}"
    case "$pnpm_major" in
      ''|*[!0-9]*) fail "Could not read the pnpm version. pnpm -v said: $(first_line "$pnpm_out")" ;;
    esac
    if [ "$pnpm_major" -ge "$PNPM_MAJOR_MIN" ]; then
      say "pnpm $pnpm_version."
      return 0
    fi
    say "pnpm $pnpm_version is too old. Jarhead needs pnpm ${PNPM_MAJOR_MIN} or newer. One of these, then run this again:"
  else
    say "pnpm ${PNPM_MAJOR_MIN} or newer is needed. One of these, then run this again:"
  fi
  say "  npm install -g pnpm@${PNPM_MAJOR_MIN}"
  if have corepack; then say "  corepack enable"; fi
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
    update
  elif [ -e "$DIR" ]; then
    fail "$DIR exists and is not a git checkout; move it or set JARHEAD_DIR to another folder."
  else
    say "Cloning Jarhead to $DIR."
    # Blobs come on demand: the checkout gets today's files, not every version of every file.
    run git clone --quiet --filter=blob:none --branch "$REF" "$REPO_URL" "$DIR" || fail "Could not clone $REPO_URL ($REF). Check the network and JARHEAD_REF, then run this again."
  fi
  if ! dry; then say "At $(git -C "$DIR" rev-parse --short HEAD)."; fi
}

# pnpm build:mac redraws two tracked PNGs (scripts/make-icon.ts, the icon strip and its README copy).
# Where this Mac's Node deflates them to other bytes, the last install left them changed. That is the
# build's own output, not an edit, so a rerun puts them back instead of stopping on them.
ICON_STRIPS="apps/mac/Resources/preview-icon-sizes.png
docs/media/icon-sizes.png"

# An existing checkout. Uncommitted changes stop it before git changes anything. With no commits of
# its own it fast-forwards. With some (a self-edit Jarhead applied, or yours) they are rebased onto
# origin's $REF, and a rebase that does not apply cleanly is undone. Every stop is a jarhead: line.
update() {
  dir_q="$(quote "$DIR")"
  changed="$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null | cut -c 4- || true)"
  if [ -n "$changed" ]; then
    edits="$(printf '%s\n' "$changed" | grep -v -x -F "$ICON_STRIPS" || true)"
    if [ -n "$edits" ]; then
      say "$DIR has uncommitted changes. Commit or stash them, then run this again:"
      say "  git -C $dir_q stash"
      exit 1
    fi
    say "The last build redrew the icon strips. They go back to the committed copies."
    # shellcheck disable=SC2086 # one path per line, from ICON_STRIPS, none with a space
    run git -C "$DIR" checkout --quiet HEAD -- $changed || fail "Could not restore the icon strips. See why with: git -C $dir_q status"
  fi
  run git -C "$DIR" fetch --quiet origin "$REF" || fail "Could not fetch $REF from origin. Check the network and JARHEAD_REF, then run this again."
  run git -C "$DIR" checkout --quiet "$REF" || fail "Could not check out $REF in $DIR. See why with: git -C $dir_q status"
  # A dry run fetched nothing, so the last fetch's view of origin stands in for this one's.
  upstream="FETCH_HEAD"
  if dry; then upstream="origin/$REF"; fi
  ahead="$(git -C "$DIR" rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)"
  if [ "$ahead" = "0" ]; then
    run git -C "$DIR" merge --quiet --ff-only "$upstream" || fail "Could not fast-forward $DIR to origin's $REF. See why with: git -C $dir_q status"
    return 0
  fi
  say "$DIR has $ahead commit(s) of its own, a self-edit or yours. They go on top of origin's $REF."
  # The rebase writes commits; with no git identity set, Jarhead's own (the one self-edits use).
  identity=""
  if [ -z "$(git -C "$DIR" config user.email 2>/dev/null || true)" ]; then identity="-c user.name=Jarhead -c user.email=jarhead@localhost"; fi
  # shellcheck disable=SC2086 # the identity is two -c options or nothing
  if run git $identity -C "$DIR" rebase --quiet "$upstream"; then return 0; fi
  # A rebase stopped on a conflict is undone through run, announced like every other change.
  git_dir="$(git -C "$DIR" rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [ -n "$git_dir" ] && { [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]; }; then
    run git -C "$DIR" rebase --abort || fail "The rebase stopped and could not be undone. See where it stands with: git -C $dir_q status"
  fi
  say "Those commits do not rebase cleanly onto origin's $REF. The checkout is back as it was. Finish by hand:"
  say "  cd $dir_q && git rebase $(quote "origin/$REF")"
  say "Or install a fresh copy into another folder:"
  say "  curl -fsSL https://jarhead.kevinliu.studio/install.sh | JARHEAD_DIR=$(quote "$DIR-fresh") sh"
  exit 1
}

build() {
  if dry; then say "In $DIR:"; else cd "$DIR"; fi
  say "Installing dependencies (the site's are left out)."
  run pnpm install --filter '!./site'
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
  say "a self-signed Code Signing certificate from Keychain Access keeps them. Check with: cd $(quote "$DIR") && pnpm run doctor"
  if no_open; then return 0; fi
  # The install renamed new files in under the running app, which keeps the old build until it quits.
  if ! dry && pgrep -x Jarhead >/dev/null 2>&1; then
    say "Jarhead is running the build from before this install. Quit Jarhead, then open it again:"
    say "  open -a Jarhead"
    return 0
  fi
  say "Opening Jarhead."
  run open -a Jarhead || say "Could not open the app; open /Applications/Jarhead.app yourself."
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
