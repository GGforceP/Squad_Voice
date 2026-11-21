ARG GO_IMAGE=public.ecr.aws/docker/library/golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
ARG DEBIAN_IMAGE=public.ecr.aws/docker/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

FROM ${GO_IMAGE} AS build
WORKDIR /src
COPY server/ ./
COPY LICENSE /out/licenses/SquadVoice.txt
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    set -eu; \
    if [ ! -d vendor ]; then go mod vendor; fi; \
    CGO_ENABLED=0 GOMAXPROCS=2 go build -mod=vendor -trimpath -ldflags="-s -w" -o /out/squadvoice . \
    && find vendor -type f \( -iname 'LICENSE*' -o -iname 'NOTICE*' -o -name PATENTS -o -name COPYING \) \
        -exec sh -c 'for notice; do target="/out/licenses/$notice"; mkdir -p "$(dirname "$target")"; cp "$notice" "$target"; done' sh {} + \
    && mkdir -p /out/run/squadvoice /out/data \
    && chown -R 10001:10001 /out/run/squadvoice /out/data

FROM scratch AS backend
COPY --from=build /out/squadvoice /squadvoice
COPY --from=build --chown=10001:10001 /out/run /run
COPY --from=build --chown=10001:10001 /out/data /data
COPY --from=build /out/licenses /usr/local/share/licenses/squadvoice
USER 10001:10001
ENTRYPOINT ["/squadvoice"]
CMD ["serve"]

FROM ${DEBIAN_IMAGE} AS runtime
ARG APT_MIRROR=deb.debian.org
RUN sed -i "s/deb.debian.org/${APT_MIRROR}/g" /etc/apt/sources.list.d/debian.sources

FROM runtime AS media
RUN apt-get -o Acquire::Retries=2 update \
    && apt-get install -y --no-install-recommends nftables util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY server/.deps/livekit_1.13.11_linux_amd64.tar.gz /tmp/livekit.tar.gz
RUN echo '1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb  /tmp/livekit.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/livekit.tar.gz -C /usr/local/bin livekit-server \
    && mkdir -p /usr/local/share/licenses/livekit \
    && tar -xzf /tmp/livekit.tar.gz -C /usr/local/share/licenses/livekit LICENSE \
    && rm /tmp/livekit.tar.gz
COPY --from=build /out/squadvoice /squadvoice
COPY --from=build /out/licenses /usr/local/share/licenses/squadvoice
COPY --chmod=0755 server/deploy/media-start.sh /media-start.sh
ENTRYPOINT ["/media-start.sh"]

FROM runtime AS edge
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY server/.deps/caddy_2.11.9_linux_amd64.tar.gz /tmp/caddy.tar.gz
RUN echo '5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb  /tmp/caddy.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy \
    && mkdir -p /usr/local/share/licenses/caddy \
    && tar -xzf /tmp/caddy.tar.gz -C /usr/local/share/licenses/caddy LICENSE \
    && rm /tmp/caddy.tar.gz
COPY --from=build /out/licenses /usr/local/share/licenses/squadvoice
COPY server/deploy/Caddyfile /etc/caddy/Caddyfile
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/tmp
ENTRYPOINT ["/usr/local/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
