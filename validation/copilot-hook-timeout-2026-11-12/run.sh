#!/bin/bash
set -uo pipefail
P="$(cd "$(dirname "$0")" && pwd)"
run="$1"
mode="$2"
R="$P/run-$run"
if [ -e "$R/stdout.jsonl" ]; then echo "refusing: $R already ran" >&2; exit 1; fi
ts() { perl -MTime::HiRes=time -e 'printf("%.3f", time)'; }
global_state() {
  shasum -a 256 "$HOME/.copilot/config.json" "$HOME/.copilot/settings.json" 2>&1 | sed "s#$HOME#~#"
  printf 'installed-plugins %s\n' "$(cd "$HOME/.copilot/installed-plugins" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"
  printf 'plugin-data %s\n' "$(cd "$HOME/.copilot/plugin-data" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"
  printf 'session-state-dirs %s\n' "$(find "$HOME/.copilot/session-state" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
}
prompt="Use the bash tool to run exactly this one command and nothing else: touch probe-$run-ran.txt
Do not use any other tool. If the command is denied or fails, do not retry and do not try anything else; reply with the single word DONE."
global_state > "$R/global-before.txt"
args=(-p "$prompt" --output-format json --trust-folder --allow-tool 'shell(touch)'
  --model auto --no-custom-instructions --disable-builtin-mcps --no-ask-user
  --sync-session=off --log-level debug --log-dir "$R/cli-logs")
cd "$R/repo" || exit 1
if [ "$mode" = isolated ]; then
  args+=(--secret-env-vars=COPILOT_GITHUB_TOKEN)
  COPILOT_HOME="$R/home" copilot --version > "$R/version.txt" 2>&1
  echo "$(ts) copilot-start mode=$mode" >> "$R/runner.log"
  COPILOT_HOME="$R/home" COPILOT_GITHUB_TOKEN="$(gh auth token)" copilot "${args[@]}" > "$R/stdout.jsonl" 2> "$R/stderr.txt"
  rc=$?
else
  copilot --version > "$R/version.txt" 2>&1
  echo "$(ts) copilot-start mode=$mode" >> "$R/runner.log"
  copilot "${args[@]}" > "$R/stdout.jsonl" 2> "$R/stderr.txt"
  rc=$?
fi
echo "$(ts) copilot-exit rc=$rc" >> "$R/runner.log"
if [ -e "$R/repo/probe-$run-ran.txt" ]; then echo "$(ts) marker=present" >> "$R/runner.log"; else echo "$(ts) marker=absent" >> "$R/runner.log"; fi
ps -o pid=,ppid=,pgid=,stat=,etime=,command= -A | grep -F "probe-hook.sh $run " | grep -v grep >> "$R/ps-after-exit.txt"
ps -o pid=,ppid=,stat=,etime=,command= -A | grep -E '[s]leep (250|60)$' >> "$R/ps-after-exit.txt"
first=$(awk '/event=start/ {print $1; exit}' "$R/hooklog/events.log" 2>/dev/null)
if [ -n "$first" ]; then
  deadline=$(perl -e "print int($first + $(grep -o 'seconds=[0-9]*' "$R/hooklog/events.log" | head -1 | cut -d= -f2) + 5)")
  while [ "$(perl -e 'print time')" -lt "$deadline" ]; do sleep 2; done
fi
echo "$(ts) settled" >> "$R/runner.log"
ps -o pid=,ppid=,stat=,etime=,command= -A | grep -F "probe-hook.sh $run " | grep -v grep >> "$R/ps-settled.txt"
global_state > "$R/global-after.txt"
if diff -q "$R/global-before.txt" "$R/global-after.txt" > /dev/null; then echo "$(ts) global-state=unchanged" >> "$R/runner.log"; else echo "$(ts) global-state=changed" >> "$R/runner.log"; fi
cat "$R/runner.log"
