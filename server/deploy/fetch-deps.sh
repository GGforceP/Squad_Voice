#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .deps

download() {
    url=$1
    file=$2
    hash=$3
    if [ -f "$file" ] && printf '%s  %s\n' "$hash" "$file" | sha256sum -c --status; then
        return
    fi
    curl --fail --silent --show-error --location --max-time 180 "$url" -o "$file.part"
    printf '%s  %s\n' "$hash" "$file.part" | sha256sum -c -
    mv "$file.part" "$file"
}

download 'https://github.com/livekit/livekit/releases/download/v1.13.11/livekit_1.13.11_linux_amd64.tar.gz' \
    .deps/livekit_1.13.11_linux_amd64.tar.gz 1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb
download 'https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_amd64.tar.gz' \
    .deps/caddy_2.11.9_linux_amd64.tar.gz 5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb
