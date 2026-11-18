#!/usr/bin/env bash
# Shell-side facts for /deliberation:doctor. Every check runs in the `doctor` MCP tool; this
# prints only what the server cannot see: the session store dir THIS shell resolves, which the
# command passes to the tool as shellSessionsDir for the path drift check.

set -u

SD="${DELIBERATION_SESSIONS:-${XDG_CACHE_HOME:-$HOME/.cache}/deliberation/sessions}"
case "$SD" in /*) ;; *) SD="$HOME/.cache/deliberation/sessions";; esac
echo "SHELL_SESSIONS_DIR=$SD"
