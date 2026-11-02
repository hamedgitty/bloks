# syntax=docker/dockerfile:1
#
# Bloks on a server of your own, in a container: the release's
# bloks-server, checked against the sha256 the release publishes, running
# as an account of its own with everything it keeps in one volume.
# compose.yml beside this file runs it, and docs/DOCKER.md walks through
# it from nothing. The release workflow publishes this same image to
# ghcr.io/hamedgitty/bloks-server (.github/workflows/container.yml).
#
#   docker build -t bloks-server .                       # the latest release
#   docker build --build-arg BLOKS_VERSION=3.2.1 -t bloks-server .

ARG NODE_VERSION=22

# ── the release, fetched and checked ─────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS release
ARG BLOKS_VERSION=latest
ARG BLOKS_REPO=hamedgitty/bloks
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/release
# "latest" is asked of GitHub, the way `bloks-server update` asks; a
# version is taken as given. Either way the tarball is unpacked only if it
# matches the checksum published beside it.
RUN set -eu; \
    version="${BLOKS_VERSION#v}"; \
    if [ "$version" = "latest" ] || [ -z "$version" ]; then \
      version="$(curl -fsSL "https://api.github.com/repos/${BLOKS_REPO}/releases/latest" \
        | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const t=JSON.parse(s).tag_name||"";process.stdout.write(t.replace(/^v/,""))})')"; \
    fi; \
    echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "No release version to build ($version)."; exit 1; }; \
    name="bloks-server-${version}.tar.gz"; \
    base="https://github.com/${BLOKS_REPO}/releases/download/v${version}"; \
    curl -fsSLO "${base}/${name}"; \
    curl -fsSLO "${base}/${name}.sha256"; \
    sha256sum -c "${name}.sha256"; \
    mkdir -p /opt/bloks-server; \
    tar -xzf "${name}" --strip-components=1 -C /opt/bloks-server; \
    rm -f /opt/bloks-server/Dockerfile /opt/bloks-server/bloks-server.service

# ── the server ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim

# What agents reach for on a server: a shell, git and ssh for remotes,
# curl, ripgrep, python, and tini to pass signals on and reap what their
# commands leave behind. `script` (the terminal's pty) is already here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git less openssh-client procps python3 ripgrep tini \
 && rm -rf /var/lib/apt/lists/*

# The node image's own account, uid and gid 1000, renamed: the first
# account on most machines, so a folder bind-mounted from the host is
# usually already its. Never root, and no sudo.
RUN usermod -l bloks -d /home/bloks -m node && groupmod -n bloks node

# The release stays root's, so nothing Bloks or an agent runs can change
# the code it runs; an update is a newer image (docs/DOCKER.md).
COPY --from=release /opt/bloks-server /opt/bloks-server
RUN printf '#!/bin/sh\nexec node /opt/bloks-server/bin/bloks-server.mjs "$@"\n' > /usr/local/bin/bloks-server \
 && chmod 0755 /usr/local/bin/bloks-server

# Everything Bloks keeps is under /home/bloks, one volume: the workspace
# (.bloks), the engines installed from the app or the terminal (.local),
# and their sign-ins (.claude, .codex and the rest), so recreating the
# container loses none of it.
#
# BLOKS_LISTEN: listen beyond the container's own loopback, so the port
# compose.yml publishes reaches it. Who reaches that port is the publish
# line's to say, and nothing past /api/health answers without a paired
# device's token (docs/SELF_HOSTING.md).
ENV HOME=/home/bloks \
    BLOKS_DATA_DIR=/home/bloks/.bloks \
    BLOKS_LISTEN=0.0.0.0 \
    BLOKS_PORT=8799 \
    BLOKS_CONTAINER=image \
    NPM_CONFIG_PREFIX=/home/bloks/.local \
    PATH=/home/bloks/.local/bin:$PATH

USER bloks
WORKDIR /home/bloks
VOLUME ["/home/bloks"]
EXPOSE 8799

# /api/health answers anyone, a container's own loopback included, and
# only once the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BLOKS_PORT||8799)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bloks-server"]
