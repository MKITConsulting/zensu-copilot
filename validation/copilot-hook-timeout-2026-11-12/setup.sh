#!/bin/bash
set -euo pipefail
P="$(cd "$(dirname "$0")" && pwd)"
for spec in "a 250 260" "b 60 5"; do
  set -- $spec
  run="$1"; sleep_s="$2"; timeout_s="$3"
  R="$P/run-$run"
  if [ -e "$R" ]; then echo "refusing: $R exists" >&2; exit 1; fi
  mkdir -p "$R/repo/.github/hooks" "$R/hooklog" "$R/cli-logs" "$R/home"
  cp "$P/probe-hook.sh" "$R/repo/.github/hooks/probe-hook.sh"
  chmod 755 "$R/repo/.github/hooks/probe-hook.sh"
  cat > "$R/repo/.github/hooks/probe.json" <<EOF
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "bash $R/repo/.github/hooks/probe-hook.sh $run $sleep_s $R/hooklog",
        "timeoutSec": $timeout_s
      }
    ]
  }
}
EOF
  printf '# Hook timeout probe %s\n' "$run" > "$R/repo/README.md"
  git -C "$R/repo" init -q -b main
  git -C "$R/repo" add -A
  git -C "$R/repo" -c user.name=probe -c user.email=probe@example.invalid commit -q -m "chore: hook timeout probe fixture"
  echo "ready: $R (sleep ${sleep_s}s, timeoutSec ${timeout_s})"
done
