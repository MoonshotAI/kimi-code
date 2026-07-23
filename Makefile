.PHONY: prepare build typecheck lint lint-fix lint-pkg sherif test test-watch test-coverage clean changeset version publish release dev vis help

## Setup

prepare: ## Install project dependencies
	pnpm install

## Build

build: ## Build all workspace packages
	pnpm run build

## Quality

typecheck: ## Type-check all workspace packages
	pnpm run typecheck

lint: ## Run lint checks
	pnpm run lint

lint-fix: ## Fix lint issues
	pnpm run lint:fix

sherif: ## Check monorepo package configuration
	pnpm run sherif

lint-pkg: ## Lint package metadata
	pnpm run lint:pkg

## Test

test: ## Run the test suite
	pnpm run test

test-watch: ## Run tests in watch mode
	pnpm run test:watch

test-coverage: ## Run tests with coverage
	pnpm run test:coverage

## Clean

clean: ## Remove build artifacts
	pnpm run clean

## Release

changeset: ## Create a changeset
	pnpm run changeset

version: ## Apply changesets and update versions
	pnpm run version

publish: ## Publish packages
	pnpm run publish

release: version publish ## Version and publish packages

## Development

dev: ## Start the CLI in development mode
	pnpm run dev:cli

## vis

vis: ## Start the session visualization tools
	pnpm run vis

## Help

help: ## Show this help message
	@awk 'BEGIN { printf "Usage: make <target>\n" } \
		/^## / { printf "\n%s:\n", substr($$0, 4); next } \
		/^[a-zA-Z0-9_-]+:.*## / { split($$0, parts, ":.*## "); printf "  %-16s %s\n", parts[1], parts[2] }' \
		$(firstword $(MAKEFILE_LIST))
