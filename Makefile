IMAGE ?= cellux/agent-sandbox
TAG ?= latest
IMAGE_REF := $(IMAGE):$(TAG)

# Optional path to a PEM CA bundle used by the corporate HTTPS proxy. The
# bundle is passed to BuildKit as a secret and installed into the image trust
# store; it is never sent as part of the Docker build context. For example:
#   make build CA_CERT_BUNDLE=/etc/ssl/corporate-ca-bundle.pem
CA_CERT_BUNDLE ?=

.DEFAULT_GOAL := help

EXTENSION_PACKAGE_DIRS := $(patsubst %/package.json,%,$(wildcard extensions/*/package.json))

.PHONY: help build install update

help:
	@printf '%s\n' \
		'Available targets:' \
		'  help                   Show this help text.' \
		'  build                  Build the agent sandbox Docker image.' \
		'  install                Install dependencies for core and all extensions.' \
		'  update                 Update dependencies in core and all extensions.' \
		'' \
		'Build variables:' \
		'  IMAGE                  Image name (default: cellux/agent-sandbox).' \
		'  TAG                    Image tag (default: latest).' \
		'  CA_CERT_BUNDLE        Optional PEM CA bundle for corporate HTTPS proxies.' \
		'' \
		'Examples:' \
		'  make build' \
		'  make build IMAGE=example/agent-sandbox TAG=dev' \
		'  make build CA_CERT_BUNDLE=/etc/ssl/corporate-ca-bundle.pem'

build:
	@set -eu; \
	if test -n "$(CA_CERT_BUNDLE)"; then \
		test -f "$(CA_CERT_BUNDLE)" && test -r "$(CA_CERT_BUNDLE)" || { \
			echo "CA_CERT_BUNDLE must name a readable file: $(CA_CERT_BUNDLE)" >&2; \
			exit 1; \
		}; \
		ca_bundle_sha256=$$(sha256sum "$(CA_CERT_BUNDLE)" | cut --delimiter=' ' --fields=1); \
		DOCKER_BUILDKIT=1 docker build \
			--build-arg "CORPORATE_CA_BUNDLE_SHA256=$$ca_bundle_sha256" \
			--secret "id=corporate-ca,src=$(CA_CERT_BUNDLE)" \
			--tag "$(IMAGE_REF)" .; \
	else \
		DOCKER_BUILDKIT=1 docker build \
			--build-arg CORPORATE_CA_BUNDLE_SHA256=none \
			--tag "$(IMAGE_REF)" .; \
	fi

install:
	@set -eu; \
	echo "Installing core dependencies:"; \
	npm install; \
	for dir in $(EXTENSION_PACKAGE_DIRS); do \
		echo "Installing extension dependencies in $$dir:"; \
		npm install --prefix "$$dir"; \
	done

update:
	@set -eu; \
	echo "Updating core dependencies:"; \
	npm update; \
	for dir in $(EXTENSION_PACKAGE_DIRS); do \
		echo "Updating extension dependencies in $$dir:"; \
		npm update --prefix "$$dir"; \
	done
