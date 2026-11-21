#!/bin/sh
set -eu

# This process has its own Docker network namespace. Install the filter
# before the SFU starts; a failure leaves no media listener.
/squadvoice geo nft /config/geo.json > /tmp/squadvoice.nft
if nft list table inet squadvoice >/dev/null 2>&1; then
    printf '%s\n' 'delete table inet squadvoice' > /tmp/squadvoice-replace.nft
    cat /tmp/squadvoice.nft >> /tmp/squadvoice-replace.nft
    nft -f /tmp/squadvoice-replace.nft
else
    nft -f /tmp/squadvoice.nft
fi
/squadvoice livekit-config > /tmp/livekit.json
chmod 0444 /tmp/livekit.json
exec setpriv --reuid 10001 --regid 10001 --clear-groups \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
    /usr/local/bin/livekit-server --config /tmp/livekit.json --key-file /config/keys.json
