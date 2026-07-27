#!/usr/bin/env bash
# Fake agy WITHOUT --model support (agy < 1.0.9). Same contract as fake-agy.sh
# except the --help output advertises no --model flag, so the bridge's capability
# probe must omit the flag instead of producing argv the real old binary rejects.
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  echo "  -p                              Short alias for --print"
  exit 0
fi

# Old agy rejects unknown flags outright; mimic that so a regression is loud.
for arg in "$@"; do
  if [ "$arg" = "--model" ]; then
    echo "Error: flags provided but not defined: -model" >&2
    exit 1
  fi
done

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

echo "FAKE AGY OK"
exit 0
