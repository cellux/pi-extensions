IMAGE ?= cellux/agent-sandbox
TAG ?= latest
IMAGE_REF := $(IMAGE):$(TAG)

.DEFAULT_GOAL := build
.PHONY: build

build:
	docker build --tag "$(IMAGE_REF)" .
