#!/bin/sh
# usage: scripts/multi.sh GAMES seed1 seed2 ...  (runs seeds in parallel, prints selected lines)
G=$1; shift
for s in "$@"; do (npx tsx scripts/simulate.ts $G $s > /tmp/sim_$s.txt 2>&1 &) ; done
sleep 1; wait
