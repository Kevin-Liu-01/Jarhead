#!/bin/sh
# Checks scripts/install.sh without running it for real: a syntax pass, shellcheck when it is
# installed, a dry run that must exit 0 and print the plan and exactly the README's four commands
# (README:23-29) in order, and greps for what the script must never do. Also checks that the page's
# own words never claim a download, a .dmg or a cask (facts-product.md §5.1).
# Wired as `pnpm -C site check:install`.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
site="$(cd "$here/.." && pwd)"
root="$(cd "$site/.." && pwd)"
script="$root/scripts/install.sh"
content="$site/content/install.ts"
status=0

ok() { printf 'check-install: ok    %s\n' "$*"; }
bad() { printf 'check-install: FAIL  %s\n' "$*" >&2; status=1; }

[ -f "$script" ] || { printf 'check-install: %s is missing\n' "$script" >&2; exit 1; }

# 1  syntax
if sh -n "$script"; then ok "sh -n"; else bad "sh -n"; fi

# 2  shellcheck, when present
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -s sh "$script"; then ok "shellcheck"; else bad "shellcheck"; fi
else
  printf 'check-install: skip  shellcheck (not installed)\n'
fi

# 3  the dry run: exit 0, the plan printed, exactly the four README commands in order. The caller's
#    JARHEAD_NO_OPEN and JARHEAD_REF are dropped and the clone path is a folder that does not exist, so
#    the run is the same on every Mac: the checks, a clone, the four commands, the open.
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
if (unset JARHEAD_NO_OPEN JARHEAD_REF; JARHEAD_DIR="$out.jarhead" JARHEAD_DRY_RUN=1 sh "$script") >"$out" 2>&1; then
  ok "dry run exits 0"
else
  bad "dry run exited non-zero:"
  cat "$out" >&2
fi
if grep -q '^jarhead: The plan:$' "$out"; then ok "prints the plan"; else bad "no plan printed"; fi
if grep -q '^jarhead: Dry run: every step is printed, none is run\.$' "$out"; then ok "says it is a dry run"; else bad "dry run not announced"; fi
expected='pnpm install
pnpm build:hands
pnpm build:mac
open -a Jarhead'
# git lines are the clone or the pull; a corepack line is the pnpm fix on a Mac without pnpm; neither is a README command
actual="$(sed -n 's/^jarhead: \$ //p' "$out" | grep -v -E '^(git|corepack) ' || true)"
if [ "$actual" = "$expected" ]; then
  ok "the four README commands, in order"
else
  bad "commands differ from README:23-29; got:"
  printf '%s\n' "$actual" >&2
fi
if grep -q -E '^jarhead: \$ git clone .*Kevin-Liu-01/Jarhead\.git |^jarhead: \$ git -C .* pull --quiet --ff-only origin ' "$out"; then
  ok "clones, or pulls an existing checkout"
else
  bad "neither a clone nor a pull was announced"
fi

# 4  what it must never do: outside comments and printed messages, no sudo, no rm, no ~/.jarhead/env,
#    and pnpm run doctor is named, never run
body="$(grep -v -E '^[[:space:]]*#' "$script" | grep -v -E '^[[:space:]]*(say|fail) ')"
if printf '%s\n' "$body" | grep -q -w 'sudo'; then bad "sudo appears outside comments and messages"; else ok "no sudo"; fi
if printf '%s\n' "$body" | grep -q -w 'rm'; then bad "rm appears outside comments and messages"; else ok "no rm"; fi
if printf '%s\n' "$body" | grep -q -F '.jarhead/env'; then bad "~/.jarhead/env is touched outside comments and messages"; else ok "never touches ~/.jarhead/env"; fi
if printf '%s\n' "$body" | grep -q 'doctor'; then bad "pnpm run doctor is run; it may only be named"; else ok "pnpm run doctor is named, never run"; fi
if grep -q -E '^main "\$@"$' "$script" && [ "$(tail -n 1 "$script")" = 'main "$@"' ]; then ok "one main, called on the last line"; else bad "main is not the last line"; fi
if grep -q '^set -eu$' "$script"; then ok "set -eu"; else bad "no set -eu"; fi

# 5  the page's own words
if [ -f "$content" ]; then
  if grep -q -i -E 'download|\.dmg|cask' "$content"; then bad "content/install.ts claims a download, .dmg or cask"; else ok "no download, .dmg or cask in content/install.ts"; fi
fi

exit "$status"
