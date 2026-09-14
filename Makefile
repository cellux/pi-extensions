IMAGE ?= cellux/agent-sandbox
TAG ?= latest
IMAGE_REF := $(IMAGE):$(TAG)

.DEFAULT_GOAL := build

EXTENSION_PACKAGE_DIRS := $(patsubst %/package.json,%,$(wildcard extensions/*/package.json))

.PHONY: build install-extension-deps

build:
	docker build --tag "$(IMAGE_REF)" .

install-extension-deps:
	@set -eu; \
	for dir in $(EXTENSION_PACKAGE_DIRS); do \
		echo "Installing extension dependencies in $$dir"; \
		npm install --prefix "$$dir"; \
	done
