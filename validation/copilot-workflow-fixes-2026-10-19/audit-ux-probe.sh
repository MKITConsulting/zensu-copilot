#!/usr/bin/env bash
# Scripted native probe, executed by Copilot in its disposable test project.
# This exercises real hook binding, not an autonomous full workflow.
set -euo pipefail
cd "$COPILOT_PROJECT_DIR"
audit="$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-edit-landing.sh"
helper="$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-log.sh"
log="$COPILOT_PROJECT_DIR/.zensu/logs/audit-ux.log"
out="$COPILOT_PROJECT_DIR/.zensu/audit-ux-probe"
mkdir -p "$out"
key="$(bash "$helper" --session-key)"
receipt="$COPILOT_PROJECT_DIR/.zensu/state/edit-landing-$key.json"
run_audit() {
  local expected="$1" label="$2" code=0
  shift 2
  bash "$audit" --log "$log" --project "$COPILOT_PROJECT_DIR" "$@" >"$out/$label.stdout" 2>"$out/$label.stderr" || code=$?
  test "$code" = "$expected"
}
run_audit 0 standalone
grep -q 'STANDALONE AUDIT.*no workflow receipt' "$out/standalone.stderr"
test ! -e "$receipt"
printf 'PASS standalone-before-workflow\n'
bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-tdd-mode.sh" --vanilla
bash "$helper" --tdd-begin
# Explicit diagnostic cleanup, never a successful workflow-completion claim.
trap 'bash "$helper" --tdd-reset' EXIT
for label in omitted disabled alternate; do
  case "$label" in
    disabled) run_audit 2 "$label" --receipt - ;;
    alternate) run_audit 2 "$label" --receipt "$out/alternate.json" ;;
    omitted) run_audit 2 "$label" ;;
  esac
  grep -q 'AUDIT SESSION REQUIRED' "$out/$label.stderr"
  grep -Fq "'--session' '$COPILOT_SESSION_ID'" "$out/$label.stderr"
  ! grep -q 'EDIT LANDED\|EDIT LANDING AUDIT' "$out/$label.stdout"
  test ! -e "$receipt"
  test ! -e "$out/alternate.json"
  printf 'PASS active-%s-refused-before-grading\n' "$label"
done
run_audit 0 inventory --inventory
grep -q 'claimed-files=1' "$out/inventory.stdout"
test ! -e "$receipt"
printf 'PASS inventory-read-only\n'
run_audit 0 bound --session "$COPILOT_SESSION_ID"
node -e 'const fs=require("fs"), r=JSON.parse(fs.readFileSync(process.argv[1])); if(!r.clean || r.claims!==1 || r.session!==process.argv[2] || r.auditScope.sessionKey!==process.argv[3] || !r.auditScope.generation) process.exit(1)' "$receipt" "$COPILOT_SESSION_ID" "$key"
cp "$receipt" "$out/receipt-before.json"
printf 'PASS explicit-session-clean-receipt\n'
run_audit 2 repeat-omitted
cmp "$receipt" "$out/receipt-before.json"
printf 'PASS omitted-retry-preserves-receipt\n'
printf 'AUDIT-UX-NATIVE-PROBE-PASS\n'
