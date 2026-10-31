#!/usr/bin/env bash
# The plays t-0039 measures (seed 2, tempo quick): routine flies to CF / LF / RF, two pop-ups, ground balls fielded and thrown, a liner caught
# and thrown. Usage: tools/fly/plays.sh <out dir> [extra turn.ts args]
out=${1:?out dir}; shift
exec npx tsx tools/fly/turn.ts --seed 2 --tempo quick --pre 2.5 --post 2.5 --out "$out" "$@" \
  --play 963.37:DUL-away-b7:cf --play 1225.24:RAL-home-b6:lf --play 1457.81:DUL-away-b8:rf \
  --play 2333.67:RAL-home-rp4:pop-p --play 2026.67:DUL-away-b2:pop-1b \
  --play 802.35:RAL-home-b4:gb-3b-run --play 1421.92:DUL-away-b5:gb-ss-run --play 2295.57:RAL-home-b4:gb-3b-set --play 2957.27:RAL-home-rp5:gb-p \
  --play 1592.51:RAL-home-b7:liner-cf-throw
