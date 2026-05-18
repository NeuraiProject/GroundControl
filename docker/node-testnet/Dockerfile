# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM debian:12 AS builder

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf \
    automake \
    autotools-dev \
    binutils \
    bison \
    bsdmainutils \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    git \
    gnupg \
    libffi-dev \
    libssl-dev \
    libtool \
    meson \
    ninja-build \
    pkg-config \
    python3 \
    unzip \
    wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /root

RUN git clone --branch DePIN-Test --single-branch \
    https://github.com/NeuraiProject/Neurai.git

WORKDIR /root/Neurai/depends

# NO_QT=1 — skip building Qt and its transitive deps in depends/. Saves
# ~30-50 min off the build. ZMQ is still built by depends/ as usual and
# linked statically into neuraid.
RUN make HOST=x86_64-pc-linux-gnu NO_QT=1 -j$(nproc)

WORKDIR /root/Neurai

RUN contrib/install_db4.sh ../

ENV BDB_PREFIX=/root/db4

RUN ./autogen.sh

RUN CONFIG_SITE=$PWD/depends/x86_64-pc-linux-gnu/share/config.site \
    ./configure \
      --prefix=$PWD/depends/x86_64-pc-linux-gnu \
      --disable-shared \
      --disable-maintainer-mode \
      --disable-tests \
      --disable-bench \
      --without-gui \
      --with-pic \
      LDFLAGS="-L${BDB_PREFIX}/lib/" \
      CPPFLAGS="-I${BDB_PREFIX}/include/"

RUN make -j$(nproc)

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
