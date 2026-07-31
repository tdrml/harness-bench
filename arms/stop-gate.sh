#!/usr/bin/env bash
# harness-bench A1/FULL done-gate: block Stop unless the full test suite is green.
# Deterministic enforcement of what the prompt asks for in prose.
set -u
input=$(cat)

# Loop guard: if we already blocked and the agent is stopping again after
# continuing, let repeated saturation through via the block counter below.
case "$input" in
  *'"stop_hook_active":true'*) : ;; # still enforce, counter bounds us
esac

cnt_file=".claude/gate-blocks.count"
blocks=0
[ -f "$cnt_file" ] && blocks=$(cat "$cnt_file")

# Cost bound: after 3 blocks, stop enforcing (saturation is recorded either way).
if [ "$blocks" -ge 3 ]; then
  exit 0
fi

log=$(mktemp)
if pnpm -s test >"$log" 2>&1; then
  rm -f "$log"
  exit 0
fi

echo $((blocks + 1)) >"$cnt_file"
{
  echo "Done-gate BLOCKED your stop: the full test suite is not green yet."
  echo "Fix the code (not the tests) and verify with: pnpm -s test"
  echo "--- last lines of the failing run ---"
  tail -20 "$log"
} >&2
rm -f "$log"
exit 2
