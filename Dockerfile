# syntax=docker/dockerfile:1

FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN sed --in-place 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        black \
        build-essential \
        cargo \
        chicken-bin \
        clang \
        clang-format \
        cmake \
        ca-certificates \
        coreutils \
        csound \
        curl \
        default-jdk-headless \
        docker-cli \
        docker-compose \
        emacs-nox \
        build-essential \
        fd-find \
        file \
        findutils \
        g++ \
        gcc \
        git \
        golang-go \
        gdb \
        guile-3.0 \
        hyperfine \
        iproute2 \
        imagemagick \
        jq \
        less \
        libc-bin \
        libsdl3-dev \
        libzstd-dev \
        linux-perf \
        llvm-dev \
        lua5.4 \
        luajit \
        mc \
        nodejs \
        node-typescript \
        ninja-build \
        npm \
        openssh-client \
        perf-tools-unstable \
        pipewire-bin \
        pipewire-jack \
        pkgconf \
        podman \
        procps \
        python3 \
        python3-pil \
        python3-pip \
        python3-pydantic \
        python3-ruamel.yaml \
        python3-yaml \
        ripgrep \
        rustc \
        sbcl \
        sqlite3 \
        supercollider \
        tini \
        unzip \
        vice \
        xxd \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && ln -s /usr/bin/lua5.4 /usr/local/bin/lua \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ARG YQ_VERSION=v4.53.3
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) yq_arch=amd64 ;; \
        arm64) yq_arch=arm64 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl --fail --location --output yq \
        "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${yq_arch}"; \
    install --mode=0755 yq /usr/local/bin/yq; \
    rm -f yq

ARG UV_VERSION=0.12.9
ARG RUFF_VERSION=0.16.6
ARG TY_VERSION=0.0.78
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) astral_arch=x86_64 ;; \
        arm64) astral_arch=aarch64 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    mkdir --parents /tmp/uv /tmp/ruff /tmp/ty; \
    cd /tmp; \
    curl --fail --location --output uv.tar.gz \
        "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${astral_arch}-unknown-linux-gnu.tar.gz"; \
    curl --fail --location --output ruff.tar.gz \
        "https://github.com/astral-sh/ruff/releases/download/${RUFF_VERSION}/ruff-${astral_arch}-unknown-linux-gnu.tar.gz"; \
    curl --fail --location --output ty.tar.gz \
        "https://github.com/astral-sh/ty/releases/download/${TY_VERSION}/ty-${astral_arch}-unknown-linux-gnu.tar.gz"; \
    tar --extract --gzip --file uv.tar.gz --directory /tmp/uv --strip-components=1; \
    tar --extract --gzip --file ruff.tar.gz --directory /tmp/ruff --strip-components=1; \
    tar --extract --gzip --file ty.tar.gz --directory /tmp/ty --strip-components=1; \
    install --mode=0755 /tmp/uv/uv /usr/local/bin/uv; \
    install --mode=0755 /tmp/uv/uvx /usr/local/bin/uvx; \
    install --mode=0755 /tmp/ruff/ruff /usr/local/bin/ruff; \
    install --mode=0755 /tmp/ty/ty /usr/local/bin/ty; \
    rm -rf /tmp/uv /tmp/ruff /tmp/ty /tmp/uv.tar.gz /tmp/ruff.tar.gz /tmp/ty.tar.gz

# Install Playwright and its bundled Chromium and Firefox, including the system
# libraries needed to run them in the slim Debian image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eux; \
    npm install --global playwright; \
    mkdir --parents "$PLAYWRIGHT_BROWSERS_PATH"; \
    playwright install --with-deps chromium firefox; \
    chmod --recursive a+rX "$PLAYWRIGHT_BROWSERS_PATH"

RUN npm install --global prettier
RUN npm install --global speedscope

ARG CLOJURE_VERSION=1.12.4.1582
RUN set -eux; \
    curl --fail --location --silent --show-error \
        --output /tmp/clojure-install.sh \
        "https://download.clojure.org/install/linux-install-${CLOJURE_VERSION}.sh"; \
    chmod 0755 /tmp/clojure-install.sh; \
    /tmp/clojure-install.sh; \
    rm -f /tmp/clojure-install.sh

ARG JANET_VERSION=1.42.0
RUN set -eux; \
    cd /tmp; \
    curl --fail --location --output janet.tar.gz \
        "https://github.com/janet-lang/janet/archive/refs/tags/v${JANET_VERSION}.tar.gz"; \
    tar --extract --gzip --file janet.tar.gz; \
    cd "janet-${JANET_VERSION}"; \
    make; \
    make install PREFIX=/usr/local; \
    cd /; \
    rm -rf "/tmp/janet-${JANET_VERSION}" /tmp/janet.tar.gz

ARG CLJ_KONDO_VERSION=2026.08.04
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) clj_kondo_arch=amd64 ;; \
        arm64) clj_kondo_arch=aarch64 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl --fail --location --output clj-kondo.zip \
        "https://github.com/clj-kondo/clj-kondo/releases/download/v${CLJ_KONDO_VERSION}/clj-kondo-${CLJ_KONDO_VERSION}-linux-${clj_kondo_arch}.zip"; \
    unzip -q clj-kondo.zip; \
    install --mode=0755 clj-kondo /usr/local/bin/clj-kondo; \
    rm -f clj-kondo.zip clj-kondo

ARG CLJFMT_VERSION=0.16.5
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) cljfmt_arch=amd64 ;; \
        arm64) cljfmt_arch=aarch64 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl --fail --location --output cljfmt.tar.gz \
        "https://github.com/weavejester/cljfmt/releases/download/${CLJFMT_VERSION}/cljfmt-${CLJFMT_VERSION}-linux-${cljfmt_arch}.tar.gz"; \
    tar --extract --gzip --file cljfmt.tar.gz; \
    install --mode=0755 cljfmt /usr/local/bin/cljfmt; \
    rm -f cljfmt.tar.gz cljfmt

ARG BABASHKA_VERSION=1.13.220
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) babashka_arch=amd64 ;; \
        arm64) babashka_arch=aarch64 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl --fail --location --output babashka.tar.gz \
        "https://github.com/babashka/babashka/releases/download/v${BABASHKA_VERSION}/babashka-${BABASHKA_VERSION}-linux-${babashka_arch}-static.tar.gz"; \
    tar --extract --gzip --file babashka.tar.gz; \
    install --mode=0755 bb /usr/local/bin/bb; \
    rm -f babashka.tar.gz bb

RUN useradd --create-home --shell /bin/bash --uid 1000 sandbox \
    && install --directory --owner=sandbox --group=sandbox /home/sandbox/.m2

ENV HOME=/home/sandbox

WORKDIR /workspace
USER sandbox

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
