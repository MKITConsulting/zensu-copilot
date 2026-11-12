#!/bin/bash
set -u
run="$1"
sleep_s="$2"
log="$3"
ts() { perl -MTime::HiRes=time -e 'printf("%.3f", time)'; }
started=$(ts)
input=$(cat)
read_done=$(ts)
count=$(find "$log" -maxdepth 1 -name 'call-*.json' | wc -l | tr -d ' ')
call=$((count + 1))
printf '%s' "$input" > "$log/call-$call.json"
echo "$started call=$call pid=$$ ppid=$PPID pgid=$(ps -o pgid= -p $$ | tr -d ' ') event=start stdin_read_at=$read_done" >> "$log/events.log"
case "$input" in
  *"probe-$run-ran"*) ;;
  *)
    echo "$(ts) call=$call event=allow-unrelated" >> "$log/events.log"
    exit 0
    ;;
esac
if [ -e "$log/target-seen" ]; then
  echo "$(ts) call=$call event=deny-repeat" >> "$log/events.log"
  printf '{"permissionDecision":"deny","permissionDecisionReason":"probe-%s: repeated target call denied immediately"}\n' "$run"
  exit 0
fi
: > "$log/target-seen"
trap 'echo "$(ts) call=$call event=sigterm" >> "$log/events.log"; exit 143' TERM
trap 'echo "$(ts) call=$call event=sighup" >> "$log/events.log"; exit 129' HUP
trap 'echo "$(ts) call=$call event=sigint" >> "$log/events.log"; exit 130' INT
sleep "$sleep_s" &
sleeper=$!
echo "$(ts) call=$call event=sleeping seconds=$sleep_s sleeper_pid=$sleeper" >> "$log/events.log"
wait "$sleeper"
echo "$(ts) call=$call event=slept seconds=$sleep_s" >> "$log/events.log"
printf '{"permissionDecision":"deny","permissionDecisionReason":"probe-%s: deny after %s s"}\n' "$run" "$sleep_s"
echo "$(ts) call=$call event=deny-written" >> "$log/events.log"
exit 0
