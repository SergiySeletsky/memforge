# Contributing to MemForge

## Ways to Contribute

- Bug reports and feature requests through GitHub Issues
- Documentation improvements
- Code contributions
- Testing and feedback

## Development Setup

### Prerequisites

- **Node.js 20+** and **pnpm**
- **Memgraph 3.3+** (Docker or standalone)
- LLM API key (OpenAI or Azure)

### Getting Started

```bash
# Start Memgraph
docker compose -f docker-compose.memgraph.yml up -d

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Install and run
pnpm install
pnpm dev
```

### Running Tests

```bash
pnpm test                         # unit tests
pnpm test:e2e                     # integration tests
pnpm exec tsc --noEmit            # type check
pnpm test:pw                      # Playwright E2E
```

## Workflow

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Push and open a Pull Request

## Pull Request Guidelines

- TypeScript strict mode â€” zero `tsc` errors
- All existing tests must pass
- New features should include tests
- Update documentation as needed
