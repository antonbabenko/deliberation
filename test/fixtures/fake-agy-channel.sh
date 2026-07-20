#!/usr/bin/env bash
# Fake agy that writes caller-provided stdout verbatim and exits 0.
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

printf '%s' "${FAKE_AGY_STDOUT:-}"
exit 0
