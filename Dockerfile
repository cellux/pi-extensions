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
        gh \
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

# Release source: https://github.com/mikefarah/yq/releases
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

# Install the latest Tilt release for the image's CPU architecture.
# Release source: https://github.com/tilt-dev/tilt/releases
ARG TILT_VERSION=0.37.7
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) tilt_arch=x86_64; tilt_sha256=b695193fab68def8310cb971fa60bbe47ba0a782e24f54ebad287c13316a61b0 ;; \
        arm64) tilt_arch=arm64; tilt_sha256=9f381347fa18ffca3f1d3dcdd3f6745281a6647e6107199832ceaa62a461964a ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    rm -rf /tmp/tilt; \
    mkdir --parents /tmp/tilt; \
    cd /tmp/tilt; \
    curl --fail --location --output tilt.tar.gz \
        "https://github.com/tilt-dev/tilt/releases/download/v${TILT_VERSION}/tilt.${TILT_VERSION}.linux.${tilt_arch}.tar.gz"; \
    echo "${tilt_sha256}  tilt.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file tilt.tar.gz; \
    install --mode=0755 tilt /usr/local/bin/tilt; \
    rm -rf /tmp/tilt

# Install the latest k3d release for the image's CPU architecture.
# Release source: https://github.com/k3d-io/k3d/releases
ARG K3D_VERSION=5.9.0
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) k3d_arch=amd64; k3d_sha256=06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0 ;; \
        arm64) k3d_arch=arm64; k3d_sha256=03cde5cf23e6e8e67de5a039ecf26e5b85aca82fba3e5d13dadf904cd218a250 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl --fail --location --output k3d \
        "https://github.com/k3d-io/k3d/releases/download/v${K3D_VERSION}/k3d-linux-${k3d_arch}"; \
    echo "${k3d_sha256}  k3d" | sha256sum --check --strict; \
    install --mode=0755 k3d /usr/local/bin/k3d; \
    rm -f k3d

# Install the latest stable kubectl release for the image's CPU architecture.
# Release source: https://kubernetes.io/releases/ (stable version: https://dl.k8s.io/release/stable.txt)
# Installation reference: https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/#install-kubectl-binary-with-curl-on-linux
ARG KUBECTL_VERSION=1.37.0
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) kubectl_arch=amd64; kubectl_sha256=6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f ;; \
        arm64) kubectl_arch=arm64; kubectl_sha256=922df28df248cc00a9e025f947704f1d1482de64ece54cfe57e61f19eaf1eef3 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl --fail --location --output kubectl \
        "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${kubectl_arch}/kubectl"; \
    echo "${kubectl_sha256}  kubectl" | sha256sum --check --strict; \
    install --mode=0755 kubectl /usr/local/bin/kubectl; \
    rm -f kubectl

# Install the latest Helm release for the image's CPU architecture.
# Release source: https://github.com/helm/helm/releases
ARG HELM_VERSION=4.3.0
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) helm_arch=amd64; helm_sha256=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;; \
        arm64) helm_arch=arm64; helm_sha256=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    rm -rf /tmp/helm; \
    mkdir --parents /tmp/helm; \
    cd /tmp/helm; \
    curl --fail --location --output helm.tar.gz \
        "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${helm_arch}.tar.gz"; \
    echo "${helm_sha256}  helm.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file helm.tar.gz; \
    install --mode=0755 "linux-${helm_arch}/helm" /usr/local/bin/helm; \
    rm -rf /tmp/helm

# Release source: https://github.com/astral-sh/uv/releases
ARG UV_VERSION=0.12.9
# Release source: https://github.com/astral-sh/ruff/releases
ARG RUFF_VERSION=0.16.6
# Release source: https://github.com/astral-sh/ty/releases
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
# Release source: https://github.com/microsoft/playwright/releases
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eux; \
    npm install --global playwright; \
    mkdir --parents "$PLAYWRIGHT_BROWSERS_PATH"; \
    playwright install --with-deps chromium firefox; \
    chmod --recursive a+rX "$PLAYWRIGHT_BROWSERS_PATH"

# Release source: https://www.npmjs.com/package/prettier
RUN npm install --global prettier
# Release source: https://www.npmjs.com/package/speedscope
RUN npm install --global speedscope

# Release source: https://clojure.org/releases/
ARG CLOJURE_VERSION=1.12.4.1582
RUN set -eux; \
    curl --fail --location --silent --show-error \
        --output /tmp/clojure-install.sh \
        "https://download.clojure.org/install/linux-install-${CLOJURE_VERSION}.sh"; \
    chmod 0755 /tmp/clojure-install.sh; \
    /tmp/clojure-install.sh; \
    rm -f /tmp/clojure-install.sh

# Release source: https://github.com/janet-lang/janet/releases
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

# Release source: https://github.com/clj-kondo/clj-kondo/releases
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

# Release source: https://github.com/weavejester/cljfmt/releases
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

# Release source: https://github.com/babashka/babashka/releases
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
    && install --directory --owner=sandbox --group=sandbox /home/sandbox/.m2 \
    && install --directory --owner=sandbox --group=sandbox /home/sandbox/.pi/agent/skills

COPY --chown=sandbox:sandbox skills/ /home/sandbox/.pi/agent/skills/

ENV HOME=/home/sandbox

WORKDIR /workspace
USER sandbox

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
