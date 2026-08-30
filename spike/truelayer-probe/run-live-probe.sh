#!/bin/sh
# Live TrueLayer probe run, capturing raw transactions to spike/truelayer-probe/out/.
#
# Run from anywhere — it cds to the repo root first, because there is a
# package.json in $HOME that npm would otherwise pick up instead. The root is
# two levels up now this lives beside the spike it runs.
set -e

cd "$(dirname "$0")/../.."

if [ ! -f ~/.config/tightarse/env ]; then
  echo "missing ~/.config/tightarse/env" >&2
  exit 1
fi

set -a
. ~/.config/tightarse/env
set +a

TL_CAPTURE=1 npm run probe -w @tightarse/truelayer-probe
