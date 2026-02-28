# MemForge

A self-hosted, private memory layer for LLMs â€” built as a **single Next.js 15 full-stack monolith** backed by **Memgraph** (graph + vector + full-text in one engine).

No Python. No separate backend. API routes live alongside the UI.

## Architecture

```
  app/api/v1/          â† Next.js App Router API routes
  app/api/mcp/         â† MCP SSE transport (Model Context Protocol)
  lib/db/memgraph.ts   â† Database layer (Memgraph via Bolt)
  lib/memory/write.ts  â† Write pipeline: embed â†’ dedup â†’ write â†’ categorize â†’ entity extract
  lib/search/hybrid.ts â† BM25 + vector + Reciprocal Rank Fusion
  lib/ai/client.ts     â† LLM client (OpenAI or Azure)
  lib/embeddings/      â† Embedding providers (intelli-embed-v3 local ONNX default)
```

**Key capabilities:** bi-temporal versioning, hybrid search (BM25 + vector RRF), deduplication, entity extraction, community detection, cross-encoder reranking, namespace isolation.

## Quickstart

### Prerequisites

- **Node.js 20+** and **pnpm**
- **Memgraph 3.3+** â€” run standalone or via included Docker Compose

### 1. Start Memgraph

```bash
docker compose -f docker-compose.memgraph.yml up -d
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env â€” set your LLM API key (OpenAI or Azure) and Memgraph connection
```

### 3. Install & run

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

### Docker (full stack)

```bash
docker compose up --build
```

This starts both Memgraph and the Next.js app. UI at `http://localhost:3000`, Bolt at `localhost:7687`.

## MCP Integration

Connect any MCP-compatible client (Claude Desktop, Cursor, VS Code, etc.):

```
http://localhost:3000/mcp/<client-name>/sse/<user-id>
```

## Development

```bash
pnpm dev                    # dev server (port 3000)
pnpm test                   # unit tests (Jest, in-band)
pnpm test:e2e               # integration tests
pnpm test:pw                # Playwright E2E
pnpm exec tsc --noEmit      # type check
```

## Project Structure

| Path | Description |
|------|-------------|
| `app/` | Next.js App Router (API routes + pages) |
| `lib/` | Core library (memory, search, embeddings, DB, AI) |
| `components/` | React UI components |
| `store/` | Redux store |
| `tests/` | Jest unit + baseline tests |
| `compose/` | Docker Compose overrides for alternative vector stores |
| `docker-compose.yml` | Full stack (Memgraph + app) |
| `docker-compose.memgraph.yml` | Memgraph standalone |
| `docker-compose.portainer.yml` | Production stack for Portainer / TrueNAS |
| `docs/` | Documentation |

## License

Apache 2.0