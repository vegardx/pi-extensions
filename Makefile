.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory
SHELL := bash
.ONESHELL:

################################################################################
# Setup
################################################################################

.PHONY: install
install:  ## install all dependencies
	npm install

################################################################################
# Testing
################################################################################

.PHONY: test
test:  ## run all tests
	npx vitest run

.PHONY: test-watch
test-watch:  ## run tests in watch mode
	npx vitest watch

################################################################################
# Quality
################################################################################

.PHONY: lint
lint:  ## lint with biome
	npx biome check .

.PHONY: lint-fix
lint-fix:  ## auto-fix linter findings
	npx biome check --write .

.PHONY: format
format:  ## format with biome
	npx biome format --write .

.PHONY: typecheck
typecheck:  ## typecheck all packages
	npx tsc --noEmit

.PHONY: check
check: lint typecheck test  ## lint + typecheck + test

################################################################################
# Scaffolding
################################################################################

.PHONY: new-ext
new-ext:  ## scaffold a new extension: make new-ext NAME=foo
	@if [ -z "$(NAME)" ]; then echo "usage: make new-ext NAME=<name>"; exit 1; fi
	@if [ -d "packages/$(NAME)" ]; then echo "packages/$(NAME) already exists"; exit 1; fi
	@mkdir -p packages/$(NAME)
	@printf '%s\n' \
	  '{' \
	  '  "name": "pi-ext-$(NAME)",' \
	  '  "private": true,' \
	  '  "version": "0.0.1",' \
	  '  "type": "module",' \
	  '  "pi": { "extensions": ["./index.ts"] },' \
	  '  "peerDependencies": {' \
	  '    "@mariozechner/pi-coding-agent": "*",' \
	  '    "@sinclair/typebox": "*"' \
	  '  },' \
	  '  "peerDependenciesMeta": {' \
	  '    "@mariozechner/pi-coding-agent": { "optional": true },' \
	  '    "@sinclair/typebox": { "optional": true }' \
	  '  }' \
	  '}' > packages/$(NAME)/package.json
	@printf '%s\n' \
	  'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";' \
	  '' \
	  'export default function (pi: ExtensionAPI) {' \
	  '  pi.on("session_start", (_event, ctx) => {' \
	  '    ctx.ui.notify("$(NAME) loaded", "info");' \
	  '  });' \
	  '}' > packages/$(NAME)/index.ts
	@printf '# pi-ext-$(NAME)\n\nTest: `pi -e ./packages/$(NAME)`\n' > packages/$(NAME)/README.md
	@echo "Created packages/$(NAME)/. Run 'npm install' to register the workspace."

################################################################################
# Help
################################################################################

.PHONY: help
help:  ## show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
