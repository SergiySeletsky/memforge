.PHONY: help up down logs ui-install ui-start ui-dev ui-build

NEXT_PUBLIC_USER_ID=$(USER)

# Default target
help:
	@echo "Available commands:"
	@echo "  make up        - Start the containers (Next.js + Qdrant)"
	@echo "  make down      - Stop the containers"
	@echo "  make logs      - Show container logs"
	@echo "  make ui-install - Install frontend dependencies"
	@echo "  make ui-dev    - Install dependencies and start the frontend in dev mode"
	@echo "  make ui-build  - Build the frontend for production"

build:
	docker compose build

up:
	NEXT_PUBLIC_USER_ID=$(USER) docker compose up

down:
	docker compose down -v

logs:
	docker compose logs -f

ui-install:
	cd ui && pnpm install

ui-dev:
	cd ui && NEXT_PUBLIC_USER_ID=$(USER) pnpm install && pnpm dev

ui-build:
	cd ui && pnpm install && pnpm build
