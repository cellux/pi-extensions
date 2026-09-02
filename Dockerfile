# syntax=docker/dockerfile:1

FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG YQ_VERSION=v4.53.3
ARG CLOJURE_VERSION=1.12.4.1582
ARG CLJ_KONDO_VERSION=2026.08.04

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        cargo \
        ca-certificates \
        coreutils \
        curl \
        default-jdk-headless \
        build-essential \
        fd-find \
        findutils \
        g++ \
        gcc \
        git \
        golang-go \
        jq \
        less \
        luajit \
        nodejs \
        node-typescript \
        npm \
        openssh-client \
        procps \
        python3 \
        python3-pip \
        python3-pydantic \
        python3-ruamel.yaml \
        python3-yaml \
        ripgrep \
        rustc \
        sqlite3 \
        tini \
        unzip \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install the official Clojure, rather than Debian's
# differently packaged `clojure` launcher.
RUN set -eux; \
    curl --fail --location --silent --show-error \
        --output /tmp/clojure-install.sh \
        "https://download.clojure.org/install/linux-install-${CLOJURE_VERSION}.sh"; \
    chmod 0755 /tmp/clojure-install.sh; \
    /tmp/clojure-install.sh; \
    rm -f /tmp/clojure-install.sh

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

# Keep Playwright's browser cache outside root's home so the non-root runtime
# user can use the installed browser.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install Playwright and its bundled Chromium, including the system libraries
# Chromium needs to run in the slim Debian image.
RUN set -eux; \
    npm install --global playwright; \
    mkdir --parents "$PLAYWRIGHT_BROWSERS_PATH"; \
    playwright install --with-deps chromium; \
    chmod --recursive a+rX "$PLAYWRIGHT_BROWSERS_PATH"

# Install clj-kondo from its architecture-specific release archive.
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

# The runtime can override this with the invoking host user's UID:GID.  Keeping
# a non-root default makes direct `docker run` use safer too.
RUN useradd --create-home --shell /bin/bash --uid 1000 sandbox \
    && install --directory --owner=sandbox --group=sandbox /home/sandbox/.m2

ENV HOME=/home/sandbox

WORKDIR /workspace
USER sandbox

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
