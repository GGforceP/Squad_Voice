#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 3 ]; then
    echo 'Usage: sh deploy/initialize.sh /path/to/dbip-country-lite-YYYY-MM.csv.gz YYYY-MM COUNTRY' >&2
    exit 2
fi
dataset=$(realpath "$1")
test -s "$dataset"
install -d -m 0750 -o root -g 10001 config
docker compose run --rm --no-deps tools key-init /config/keys.json
chown 10001:10001 config/keys.json
chmod 0400 config/keys.json
docker compose run --rm --no-deps \
    --volume "$dataset:/input.csv.gz:ro" tools geo import /input.csv.gz "$2" "$3" /config/geo.json
