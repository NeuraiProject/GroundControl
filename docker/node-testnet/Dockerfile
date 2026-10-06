# ── Stage 1: Build ─────────────────────────────────────────────────────────
# Testnet runs the DePIN branch (Neurai 2.0.0): there is no up-to-date prebuilt
# image for it (neuraiproject/neurai-node-testnet only ships 1.0.6, which predates
# the testnet reset), so build neuraid from source. Mirrors the upstream
# doc/docker/Dockerfile-Linux64-qc-depin-testnet: debian:12 for a C++20 compiler,
# and depends/ now also builds liboqs (post-quantum signatures, needs cmake).
FROM debian:12 AS builder

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf \
    automake \
    autotools-dev \
    bison \
    bsdmainutils \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    g++ \
    gcc \
    git \
    libtool \
    make \
    ninja-build \
    patch \
    pkg-config \
    python3 \
    unzip \
    wget \
    xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /root

# Branch, tag or release to build. The branch moves with consensus changes, so
# rebuild with `--no-cache` (or pin a tag here) to pick up new commits.
ARG NEURAI_REF=DePIN-Test
RUN git clone --depth 1 --branch "${NEURAI_REF}" \
    https://github.com/NeuraiProject/Neurai.git

WORKDIR /root/Neurai/depends

# NO_QT=1 — skip building Qt and its transitive deps in depends/. Saves
# ~30-50 min off the build. ZMQ and liboqs are still built by depends/ as
# usual and linked statically into neuraid.
RUN make HOST=x86_64-pc-linux-gnu NO_QT=1 -j$(nproc)

WORKDIR /root/Neurai

RUN contrib/install_db4.sh ../

ENV BDB_PREFIX=/root/db4

RUN ./autogen.sh

# LIBS — the static liboqs needs libm/libdl/libpthread for configure's checks.
RUN CONFIG_SITE=$PWD/depends/x86_64-pc-linux-gnu/share/config.site \
    ./configure \
      LIBS="-lm -ldl -lpthread" \
      BDB_LIBS="-L${BDB_PREFIX}/lib -ldb_cxx-4.8" \
      BDB_CFLAGS="-I${BDB_PREFIX}/include" \
      --prefix=$PWD/depends/x86_64-pc-linux-gnu \
      --enable-cxx \
      --disable-shared \
      --disable-maintainer-mode \
      --disable-tests \
      --disable-gui-tests \
      --disable-bench \
      --with-gui=no \
      --with-pic

RUN make -j$(nproc) src/neuraid src/neurai-cli

# ── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM debian:12

LABEL chain="testnet"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /root/Neurai/src/neuraid     /usr/local/bin/neuraid
COPY --from=builder /root/Neurai/src/neurai-cli  /usr/local/bin/neurai-cli
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/data"]

ENTRYPOINT ["entrypoint.sh"]
