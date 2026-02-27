# OpenMemory — Copilot Instructions

## Architecture

OpenMemory is a **single Next.js 15 full-stack monolith** (`openmemory/ui/`).
There is no separate backend — API routes live alongside UI pages.

```
openmemory/ui/
  app/api/v1/        ← 25 Next.js App Router API routes (all memory, app, config, backup)
  app/api/mcp/       ← MCP SSE transport (Model Context Protocol server)
  lib/db/memgraph.ts ← ONLY database layer — all data lives in Memgraph
  lib/memory/write.ts← Full write pipeline (embed → dedup → write → categorize → entity extract)
  lib/memory/search.ts← listMemories() — used by GET routes
  lib/search/hybrid.ts← BM25 + vector + Reciprocal Rank Fusion (Spec 02)
  lib/ai/client.ts   ← getLLMClient() singleton (OpenAI or Azure)
  lib/embeddings/intelli.ts ← embed() — default provider: intelli-embed-v3 (1024-dim, local ONNX INT8 via @huggingface/transformers, no API key needed); falls back to Azure if configured
```

## Memgraph Data Model

All data is in Memgraph (not SQLite, not PostgreSQL). The graph schema:

```cypher
(User)-[:HAS_MEMORY]->(Memory)-[:CREATED_BY]->(App)
(Memory)-[:HAS_CATEGORY]->(Category)
(Memory)-[:HAS_ENTITY]->(Entity)
(Memory)-[:SUPERSEDES]->(OldMemory)   // bi-temporal, Spec 01
(App)-[:ACCESSED]->(Memory)           // access log
(Config {key, value})                 // standalone nodes, key = "openmemory"|"mem0"
```

**All Cypher queries must anchor to a User node first (Spec 09 — namespace isolation):**
```typescript
// ✅ CORRECT
MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memId})
// ❌ WRONG — never query Memory directly
MATCH (m:Memory {id: $memId})
```

## Critical Patterns

### Database access
Always use `runRead` / `runWrite` from `@/lib/db/memgraph`. Never import `neo4j-driver` directly.
```typescript
const rows = await runRead(`MATCH ...`, { userId, ... });
const rows = await runWrite(`MERGE ...`, { ... });
```

**SKIP/LIMIT must use `$params` — never literals.** `wrapSkipLimit()` auto-rewrites them to `toInteger()` for Memgraph compatibility.

### Bi-temporal reads (Spec 01)
Live memories always filtered with `WHERE m.invalidAt IS NULL`. Edits call `supersedeMemory()` (creates new node + `[:SUPERSEDES]` edge + sets `old.invalidAt`). Never use in-place UPDATE for user-visible content changes.

### Write pipeline (addMemory)
`lib/memory/write.ts`: context window → embed → dedup check → `CREATE Memory` node → attach App → fire-and-forget: `categorizeMemory()` + `processEntityExtraction()`. Any new write should follow this pipeline rather than writing Memory nodes directly.

### LLM / Embedding clients
Use `getLLMClient()` from `lib/ai/client.ts` and `embed()` from `lib/embeddings/intelli.ts`. LLM singleton auto-selects Azure or OpenAI based on env vars. Model for LLM calls: `process.env.LLM_AZURE_DEPLOYMENT ?? process.env.OPENMEMORY_CATEGORIZATION_MODEL ?? "gpt-4o-mini"`. Default embedding provider is [`serhiiseletskyi/intelli-embed-v3`](https://huggingface.co/serhiiseletskyi/intelli-embed-v3) — a custom-trained arctic-embed-l-v2 finetune, 1024-dim, INT8 ONNX, runs locally via `@huggingface/transformers` with no API key; chosen after benchmarking 21 providers because it beats Azure on dedup and negation safety metrics while running at ~11ms on CPU.

### Async config
`getConfigFromDb()` / `getDedupConfig()` / `getContextWindowConfig()` are **async** — they read Memgraph `Config` nodes. All callers must `await` them.

### Batch queries with UNWIND
Replace N+1 `runRead` loops with a single UNWIND query:
```typescript
const rows = await runRead(
  `UNWIND $ids AS memId MATCH (u:User {userId:$userId})-[:HAS_MEMORY]->(m {id:memId})-[:HAS_CATEGORY]->(c) RETURN memId AS id, c.name AS name`,
  { userId, ids }
);
```

### Atomic multi-step writes
```typescript
import { runTransaction } from '@/lib/db/memgraph';
const results = await runTransaction([
  { cypher: 'MERGE (u:User {userId: $userId})', params: { userId } },
  { cypher: 'CREATE (m:Memory {id: $id, content: $content})', params: { id, content } },
]);
```

### Conditional param building
Never pass `undefined` props to `runRead`/`runWrite` — Memgraph logs unused-param warnings:
```typescript
const params: Record<string, unknown> = { userId, offset, limit };
if (category) params.category = category;  // ✅
// NOT: { userId, category: undefined }    // ❌
```

### Null literals in Cypher CREATE
Memgraph rejects `{ invalidAt: null }` in property maps. Omit the property entirely — absent = semantically null.

### Tags vs Categories
- `tags` = caller-controlled exact identifiers (`string[]` on Memory node); used for scoped retrieval
- `categories` = LLM-assigned semantic labels (`:Category` nodes); assigned async via fire-and-forget

### classifyIntent fail-open (MCP)
Always wrap in its own try/catch with `STORE` default — the outer write-pipeline catch converts uncaught errors into ERROR events (memory lost).

### Next.js App Router route params
All dynamic route params are `Promise` in Next.js 15:
```typescript
type RouteParams = { params: Promise<{ memoryId: string }> };
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { memoryId } = await params;
```

## Dev Workflow

```bash
# Start dev server (from openmemory/ui/)
pnpm dev                       # port 3000

# Start Memgraph + Memgraph MAGE (required — plain Memgraph lacks BM25/vector indexes)
cd openmemory && docker-compose up

# Type check
pnpm exec tsc --noEmit

# Unit tests (must run in-band)
pnpm test

# Playwright E2E (requires running dev server)
pnpm test:pw
```

**Known pre-existing failures:** 3 tests in `tests/unit/entities/resolve.test.ts` and a `.next/types` TS error for `app/api/v1/entities/[entityId]/route.ts` — ignore these.

## Environment Variables

```
MEMGRAPH_URL=bolt://localhost:7687
MEMGRAPH_USER=memgraph
MEMGRAPH_PASSWORD=memgraph
OPENAI_API_KEY=sk-...
NEXT_PUBLIC_USER_ID=user          # identifies the active user in the UI
```
Azure LLM: `LLM_AZURE_OPENAI_API_KEY` + `LLM_AZURE_ENDPOINT` + `LLM_AZURE_DEPLOYMENT`
Azure Embedding: `EMBEDDING_AZURE_OPENAI_API_KEY` + `EMBEDDING_AZURE_ENDPOINT`

## Spec Reference

Features are tracked inline in source files and code comments. Key specs by domain:
bi-temporal writes, hybrid search (BM25+vector RRF), dedup, entity extraction,
context window, bulk ingestion, community detection, cross-encoder reranking, namespace isolation.

## Frontend Conventions

- Redux store in `store/`. Hooks in `hooks/` (e.g. `useMemoriesApi.ts`) call relative API URLs — no `NEXT_PUBLIC_API_URL`.
- `Memory.memory` (in Redux) = display text. API uses `content` (DB) and `text` (GET response).
- Async fire-and-forget calls (categorization, entity extraction) must `.catch(e => console.warn(...))` — never let them throw into the write pipeline.

## Schema Initialization

`instrumentation.ts` calls `initSchema()` (from `lib/db/memgraph.ts`) on server start to create Memgraph vector index, text index, and constraints idempotently. No manual migration step needed.


---

## Core Execution Framework

- **No confirmation loops.** Proceed: Analyse → Plan → Implement → Verify → Report. Infer intent; state what you chose.
- **Error recovery order:** (1) `pnpm exec tsc --noEmit`, (2) `pnpm test --runInBand`, (3) `pnpm build`, (4) `pnpm test:pw`. Fix at the failing tier before moving on. 3-attempt limit: escalate to refactor or revert if same fix fails 3× at same tier.
- **State:** Append session notes to `openmemory/ui/AGENTS.md`. Never create separate per-task files. Compress old entries when context grows large.
- **UI bugs:** Use Playwright MCP (`console_messages level:error` → `network_requests` → `snapshot`) before editing source.
- **Quality gates:** `"strict": true` always; zero `tsc` errors; all tests pass (3 `resolve.test.ts` pre-existing failures excepted); ≥90% coverage on new `runWrite`/write-pipeline code; new/modified API routes verified <200 ms p95.

## Testing Patterns

- **`jest.clearAllMocks()` does NOT clear `mockReturnValueOnce`/`mockResolvedValueOnce` queues.** Use `mockFn.mockReset()` in `beforeEach` of describe blocks that add Once values.
- **`makeRecord({ key: intValue })`** wraps integers as `{ low, high, toNumber }`. Use string values when asserting `toEqual` on deserialized rows.
- **`buildPageResponse`** returns `{ items, total, page, size, pages }` — always `body.items`, never `body.results`.
- **`globalThis.__memgraphDriver`** persists across `jest.resetModules()`. Set to `null` in `beforeEach` when testing driver creation.

---
<!-- removed: verbose Execution Protocol, Error Recovery table, Playwright monitoring section, Quality Gates tables — see AGENTS.md Patterns for full details -->
