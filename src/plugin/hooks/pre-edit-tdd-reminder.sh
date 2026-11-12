#!/bin/bash
set -u

_ZENSU_EXECUTED_PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 2
if [ -n "${COPILOT_PLUGIN_ROOT:-}" ]; then
  _ZENSU_DECLARED_PLUGIN_ROOT="$(cd -P -- "$COPILOT_PLUGIN_ROOT" 2>/dev/null && pwd -P)" || {
    echo "zensu: inherited COPILOT_PLUGIN_ROOT does not match the executing plugin" >&2
    exit 2
  }
  if [ "$_ZENSU_DECLARED_PLUGIN_ROOT" != "$_ZENSU_EXECUTED_PLUGIN_ROOT" ]; then
    echo "zensu: inherited COPILOT_PLUGIN_ROOT does not match the executing plugin" >&2
    exit 2
  fi
fi
COPILOT_PLUGIN_ROOT="$_ZENSU_EXECUTED_PLUGIN_ROOT"
unset _ZENSU_EXECUTED_PLUGIN_ROOT _ZENSU_DECLARED_PLUGIN_ROOT

_ZENSU_TDD_SHELL_REFERENCE=
case "${OSTYPE:-}" in
  darwin*|linux*) ;;
  *) _ZENSU_TDD_SHELL_REFERENCE=1 ;;
esac
[ "${ZENSU_TDD_GATE:-}" != "off" ] || _ZENSU_TDD_SHELL_REFERENCE=1
if [ -n "$_ZENSU_TDD_SHELL_REFERENCE" ]; then
  source "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-tdd-edit-gate.sh"
  exit 2
fi

{ PAYLOAD="$(cat)"; } 2>/dev/null

command -v node >/dev/null 2>&1 || exit 0

printf -v _ZENSU_TDD_LOG_HELPER '%q' "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh"
printf -v _ZENSU_TDD_PLUGIN_DATA '%q' "${COPILOT_PLUGIN_DATA:-}"
_ZENSU_TDD_DECISION="$(printf '%s' "$PAYLOAD" \
  | COPILOT_PLUGIN_ROOT="$COPILOT_PLUGIN_ROOT" \
    ZENSU_TDD_GATE_LOG_COMMAND="COPILOT_PLUGIN_DATA=${_ZENSU_TDD_PLUGIN_DATA} bash ${_ZENSU_TDD_LOG_HELPER}" \
    node "$COPILOT_PLUGIN_ROOT/hooks/lib/tdd-edit-gate-v1.js")"
case "$?" in
  0)
    [ -z "$_ZENSU_TDD_DECISION" ] || printf '%s\n' "$_ZENSU_TDD_DECISION"
    exit 0
    ;;
  10)
    unset ZENSU_COPILOT_PLUGIN_ROOT ZENSU_SESSION_KEY ZENSU_SESSION_CONTEXT \
      ZENSU_RUNTIME_DIGEST ZENSU_PROJECT_ROOT ZENSU_SESSION_ADOPTED _ZENSU_PROJECT_DIR_MEMO
    source "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-agent-context.sh"
    source "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-session.sh"
    zensu_emit_named_bind_deny "$PAYLOAD" "" main
    exit 0
    ;;
  11)
    source "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-agent-context.sh"
    source "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-session.sh"
    zensu_emit_hook_session_deny
    exit 0
    ;;
esac

printf '%s' "$PAYLOAD" | bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-tdd-edit-gate.sh"
