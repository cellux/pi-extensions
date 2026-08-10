# syntax=docker/dockerfile:1

FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG YQ_VERSION=v4.53.3

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        cargo \
        ca-certificates \
        clojure \
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
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

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

# The runtime can override this with the invoking host user's UID:GID.  Keeping
# a non-root default makes direct `docker run` use safer too.
RUN useradd --create-home --shell /bin/bash --uid 1000 sandbox

WORKDIR /workspace
USER sandbox

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
