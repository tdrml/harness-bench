#!/usr/bin/env bash
# harness-bench pilot-7 done-gate (v2): block Stop unless BUILD and the full
# test suite are green. v1 only ran tests; finding 17a showed vitest transpiles
# per-file without typechecking, so an agent can leave `pnpm build` broken and
# still pass the suite. Pre-registered change for pilot 7.
set -u
input=$(cat)

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
if pnpm -s build >"$log" 2>&1 && pnpm -s test >>"$log" 2>&1; then
  rm -f "$log"
  exit 0
fi

echo $((blocks + 1)) >"$cnt_file"
{
  echo "Done-gate BLOCKED your stop: build and/or the full test suite is not green yet."
  echo "Fix the code (not the tests) and verify with: pnpm -s build && pnpm -s test"
  echo "--- last lines of the failing run ---"
  tail -20 "$log"
} >&2
rm -f "$log"
exit 2
