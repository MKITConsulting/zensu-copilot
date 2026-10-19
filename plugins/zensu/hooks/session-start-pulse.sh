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
source "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-config.sh"

zensu_hook_enabled pulseSession || exit 0

HEAD=$(git rev-parse HEAD 2>/dev/null) || { echo "zensu: not a git repository, pulse session skipped" >&2; exit 0; }
BRANCH=$(git branch --show-current 2>/dev/null)
[ -z "$BRANCH" ] && BRANCH="detached"
PULSE_HEAD="$HEAD" PULSE_BRANCH="$BRANCH" node -e 'process.stdout.write(JSON.stringify({additionalContext:`zensu: pulse session ready — HEAD=${process.env.PULSE_HEAD} branch=${process.env.PULSE_BRANCH}`}))' 
