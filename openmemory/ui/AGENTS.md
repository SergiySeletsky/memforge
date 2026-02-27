# OpenMemory UI — Agent Log

---

## Completed Sessions (Summary)

| Sessions | Topic | Outcome |
|----------|-------|---------|
| 1 — Workspace Setup | Windows pnpm config, shamefully-hoist, onlyBuiltDependencies | `shamefully-hoist=true` in `.npmrc`; `onnxruntime-node` + `onnxruntime-web` in workspace-root `pnpm.onlyBuiltDependencies` |
| 2 — KuzuDB Spike | Embedded graph DB as Memgraph alternative | KuzuDB 2× faster inserts, Memgraph 6× faster search; KEPT Memgraph. Patterns: `getAll()` is async; `FLOAT[]` not `FLOAT[n]`; `JSON_EXTRACT` needs extension; inline vector literals (no `$q` param in similarity) |
| 3 — Full Pipeline Benchmark | End-to-end benchmark vs OSS baseline | Azure embedding sep=0.492, nomic sep=0.289; Azure retained as primary |
| 4–5 — MCP Eval V3 + Gap Fixes | 9.0/10 eval + fix BM25/dedup/delete-cascade | Entity identity = `(userId, toLower(name))` only; dedup threshold 0.85→0.75; RRF confidence threshold 0.02 |
| 8–9 (first) — V4/V5 Evals | `confident` field, alias resolution | Added `confident: boolean`; alias dedup resolved; `text_search.search_all()` not `search()` |
| 10–11 — MCP API surface | `add_memory→add_memories`; list_memories absorption | `list_memories` collapsed into `search_memory` browse mode (no query = paginated list) |
| 12 (first) — Entity Fragmentation | Duplicate entity nodes for same real-world entity | `normalizeName()` (lowercase + strip whitespace/punctuation); `normalizedName` stored in DB; semantic dedup via `entity_vectors` cosine threshold 0.88 + LLM confirmation; open ontology (UPPER_SNAKE_CASE types) |
| 13 (first) — Embedding Abstraction | Provider router: Azure vs nomic | `lib/embeddings/openai.ts` = provider router; startup health check in `instrumentation.ts`; silent null embeddings fixed |
| 14–21 — Embedding Benchmarks | 12+ providers across 6 test suites (Qwen3, mxbai, Arctic, Gemma, Stella, intelli-embed) | **Production**: azure (sep=0.492). **Best offline**: arctic-l-v2 (sep=0.469, 570 MB, 9.3 ms). **Best memory-holistic local**: mxbai (sep=0.432). **Selected provider**: `intelli-embed-v3` (custom arctic-embed-l-v2 finetune, 1024-dim INT8 ONNX, ~11 ms, beats Azure on dedup + negation safety). All providers fail dedupGap>0.15; BM25 negation gate required. |
| 22–25 — MTEB + Negation Safety | Submitted intelli-embed-v3; negation gate; Azure dedup threshold | BM25 lexical negation pre-filter added to dedup pipeline; Azure dedup threshold lowered to 0.55 |
| 12 (second) — Reliability Hardening | Tantivy writer killed + connection errors | `withRetry()`, `globalThis.__memgraphDriver`, `EXTRACTION_DRAIN_TIMEOUT_MS=3000`, atomic writes (2 queries not 4), `runRead` for read-only lookups |
| 13 (second) — Architectural Audit | 34 findings across all layers | Fixed `invalidAt: null` Cypher null literal bug; 7 HIGH findings documented in AUDIT_REPORT_SESSION13.md |
| 14 (second) — Lint Analysis | 100+ lint warnings | Resolved import/type issues; no new patterns |
| 15 — Frontend + API Audit | 22 new findings; 8 HIGH (frontend) | Stale closure, namespace violation, N+1 categorize documented in AUDIT_REPORT_SESSION15.md |

**Test baseline after completed sessions:** 315 tests, 45 suites, 0 failures

---

## Patterns & Architectural Decisions

### Cypher / Memgraph

```cypher
-- ALWAYS anchor to User node (Spec 09 namespace isolation)
MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memId})
-- NEVER: MATCH (m:Memory {id: $memId})   ← violates namespace isolation

-- UNWIND batch replaces N+1 sequential queries
UNWIND $ids AS memId
MATCH (m:Memory {id: memId})-[:HAS_CATEGORY]->(c:Category)
RETURN memId AS id, c.name AS name

-- Conditional param building — never pass undefined to runRead/runWrite
const params: Record<string, unknown> = { userId, offset, limit };
if (category) params.category = category;   // ✅
// NOT: { userId, category: undefined }     // ❌ Memgraph logs unused-param warning

-- Null literals rejected in CREATE
CREATE (m:Memory { content: $content })     -- ✅  omit invalidAt — absent = semantically null
CREATE (m:Memory { invalidAt: null })       -- ❌  Memgraph rejects null literal in property map
```

**SKIP/LIMIT**: Always use `wrapSkipLimit()` helper — auto-rewrites to `toInteger()` for Memgraph compatibility. Never bare integer literals.

**`runTransaction()`**: For 2+ writes that must be atomic — single Bolt write transaction with auto-rollback.

**Bi-temporal reads**: Live memories filter `WHERE m.invalidAt IS NULL`. Edits call `supersedeMemory()`. Never in-place UPDATE for user-visible changes.

**Entity merge key**: `(userId, normalizeName(name))` only — type is metadata, not identity. `normalizeName()` = lowercase + strip `[\s\-_./\\]+`.

**Cypher string concat precedence**: Parenthesize string concat in `STARTS WITH` checks — Memgraph operator precedence differs from Neo4j.

**`text_search.search_all()`**: Use instead of `text_search.search()` for BM25 full-text queries.

### Driver / Connection

```typescript
// globalThis singleton survives Next.js HMR (lib/db/memgraph.ts)
if (!globalThis.__memgraphDriver) globalThis.__memgraphDriver = neo4j.driver(url, auth, opts);

// withRetry wraps all runRead/runWrite — exponential backoff, 3 attempts, 300 ms base
// Transient errors trigger retry + driver invalidation:
// "Connection was closed by server", "Tantivy error", "index writer was killed",
// "ServiceUnavailable", "ECONNREFUSED", "ECONNRESET"
```

Pool config: `maxConnectionPoolSize: 25`, `connectionAcquisitionTimeout: 10_000`.
Memgraph 3.x: `encrypted: false` in neo4j driver options.
`--experimental-enabled=text-search` required for BM25/Tantivy.

### Write Pipeline

**Tantivy write contention**: Fire-and-forget `processEntityExtraction` from item N running when item N+1 writes → concurrent Tantivy writers panic. Fix: drain prior extraction promise before each write (`Promise.race([prev, timeout(3000)])`).

**Worker Tier 1 batch**: Single UNWIND resolves all `normalizedName` exact matches before falling back to full `resolveEntity()` per entity.

**Tags vs Categories**:
- `tags` = exact caller-controlled identifiers (`string[]` on Memory node); passed by caller; scoped retrieval
- `categories` = semantic LLM-assigned labels (`:Category` nodes via `[:HAS_CATEGORY]`); assigned async

**Global drain budget** (`add_memories` handler):
```typescript
const batchDrainDeadline = Date.now() + BATCH_DRAIN_BUDGET_MS; // 12_000
const drainMs = Math.min(PER_ITEM_DRAIN_MAX_MS, batchDrainDeadline - Date.now());
```

**`classifyIntent` fail-open**: Wrap in its own try/catch with STORE fallback — outer write-pipeline catch converts errors to ERROR events (memory lost).

**`normalizeName` in worker.ts**: Defined locally, not imported from `resolve.ts`. jest auto-mock returns `undefined` for imported functions; define pure utilities locally to avoid mock interference.

### LLM / Embedding

- `getLLMClient()` from `lib/ai/client.ts` — singleton, auto-selects Azure or OpenAI. Model: `LLM_AZURE_DEPLOYMENT ?? OPENMEMORY_CATEGORIZATION_MODEL ?? "gpt-4o-mini"`.
- `embed()` from `lib/embeddings/intelli.ts` — default: `serhiiseletskyi/intelli-embed-v3` (1024-dim INT8 ONNX, ~11 ms, no API key). Falls back to Azure when `EMBEDDING_AZURE_*` env is set.
- **Mock LLM in tests**: mock `@/lib/ai/client`, NOT the `openai` package — Azure credential check fires before `new OpenAI()`.
- **`embedDescriptionAsync`** is fire-and-forget + calls `runWrite`. Use `mockResolvedValueOnce` (not `mockResolvedValue`) so second embed call uses the default rejected state.
- Fire-and-forget calls: always `.catch(e => console.warn(...))` — never throw into write pipeline.
- Provider switch = re-index: drop + recreate Memgraph vector indexes on dimension change.

### Testing

**`jest.clearAllMocks()` does NOT clear `specificReturnValues` queue** (`mockReturnValueOnce` / `mockResolvedValueOnce`). Use `mockFn.mockReset()` in `beforeEach` of new describe blocks to drain orphaned Once values from prior blocks.

**`makeRecord()` integer wrapping**: `makeRecord({ key: intValue })` → `{ low, high, toNumber }`. Use string values when asserting `toEqual` on deserialized rows.

**`buildPageResponse` shape**: Returns `{ items, total, page, size, pages }`. Always use `body.items`, NOT `body.results`.

**`globalThis` test isolation**: Set `globalThis.__memgraphDriver = null` in `beforeEach` when testing driver creation — globalThis persists across `jest.resetModules()`.

**Generic type args on `require()`**: TS2347 — annotate the result variable instead of `<T>` on the require call.

### Infrastructure

- Windows + pnpm: `shamefully-hoist=true` in `.npmrc` — prevents webpack drive-letter casing bug.
- `pnpm.onlyBuiltDependencies` only takes effect in workspace root `package.json`.
- ESM packages in Next.js: add to both `serverExternalPackages` and webpack `externals`.
- Schema init: `instrumentation.ts` → `initSchema()` on server start (idempotent). No manual migration.
- RRF confidence threshold 0.02 = above single-arm `1/(K+1)` where K=60 (~0.016).
- BM25 is essential for short-query→long-memory separation; pure vector search insufficient.
- Negation safety: dense cosine cannot distinguish negations (negGap ≈ 0 for all models); use BM25 lexical pre-filter before cosine dedup commits.

---

## Known Pre-existing Issues

| ID | File | Description |
|----|------|-------------|
| TS-001 | `app/api/v1/entities/[entityId]/route.ts` | `.next/types` TS2344 error (activeTransports in MCP SSE) — Next.js type generation artifact, ignore |
| TEST-001 | `tests/unit/entities/resolve.test.ts` | 3 tests require live Memgraph for semantic dedup — skip in CI |
| E2E-001 | `tests/e2e/06-search.test.ts` | Requires running Memgraph + populated data — skip in CI |

---

## Session 16 — 2-Tool MCP Architecture Refactor

### Objective
Collapse 10-tool MCP API to 2 tools (`add_memories` + `search_memory`) with server-side intent classification and entity-aware search enrichment. Prior 3 audit sessions used only `search_memory` (5 calls) + `add_memories` (17 calls) — 8 tools had zero usage.

### Architecture Change

**Before:** 10 tools — `add_memories`, `search_memory`, `update_memory`, `search_memory_entities`, `get_memory_entity`, `get_related_memories`, `get_memory_map`, `create_memory_relation`, `delete_memory_relation`, `delete_memory_entity`

**After:** 2 tools — `add_memories` (writes + intent classification) + `search_memory` (reads + entity enrichment)

**Intent classification (`classifyIntent`)**:
1. Fast regex pre-filter `mightBeCommand()` — skips LLM for obvious facts
2. LLM fallback — structured JSON prompt: `STORE | INVALIDATE | DELETE_ENTITY`
3. Fail-open: any error → `STORE` (isolated try/catch, separate from write-pipeline catch)

**Entity enrichment in `search_memory`**: `searchEntities(query, userId, { limit: 5 })` auto-enriches results; best-effort; `include_entities` param (default `true`).

### Files Changed
1. `lib/mcp/classify.ts` (new, ~105 lines) — intent classifier
2. `lib/mcp/entities.ts` (new, ~230 lines) — `searchEntities`, `invalidateMemoriesByDescription`, `deleteEntityByNameOrId`
3. `lib/mcp/server.ts` — rewritten 1234 → ~430 lines; removed 8 tools; version `2.0.0`
4. `tests/unit/mcp/tools.test.ts` — removed 8 deprecated blocks; added MCP_ADD_09/10/11, MCP_SM_05/06

### Bugs Fixed During Implementation
1. `classifyIntent` threw inside outer try/catch → memory became ERROR event (lost). Fix: isolated try/catch with STORE fallback.
2. PowerShell `Set-Content -Encoding utf8` corrupted multi-byte UTF-8. Fix: delete + recreate file with `create_file`.
3. Orphaned `mockResolvedValueOnce` from MCP_ADD_11 leaked into drain tests. Fix: fail-open server fix consumed the mock.

### Type Contract Notes
- `invalidateMemoriesByDescription` returns `Array<{id, content}>`, not a count
- `DeleteEntityResult.entity` is a `string` (name), not an object
- `HybridSearchResult`: `rrfScore` (not `score`), `categories`/`appName`/`createdAt` (no `updatedAt`)
- `EntityProfile.relationships`: all four fields required — `source`, `type`, `target`, `description`

### Verification
- `tsc --noEmit`: 2 pre-existing errors only
- `jest --runInBand`: 315 tests, 45 suites, 0 failures

---

## Session 18 — Audit Findings Implementation (P1–P3)

### Objective
Implement 6 findings from the Session 17 architect audit.

### Changes Made

#### DB-01 — `runTransaction()` (lib/db/memgraph.ts)
`runTransaction(steps: Array<{cypher, params?}>): Promise<T[][]>` — multiple Cypher statements in a single Bolt write transaction with auto-rollback. Wrapped with `withRetry()`.

#### API-01 — Eliminate N+1 Category Fetch (app/api/v1/memories/route.ts)
Both `GET /api/v1/memories` code paths had a per-memory `runRead` in a `for` loop. Replaced with:
```cypher
UNWIND $ids AS memId
MATCH (m:Memory {id: memId})-[:HAS_CATEGORY]->(c:Category)
RETURN memId AS id, c.name AS name
```
`Map<id, string[]>` built once; loop does O(1) lookups.

#### MCP-02 — Global Drain Budget (lib/mcp/server.ts)
Added `BATCH_DRAIN_BUDGET_MS = 12_000` and `batchDrainDeadline = Date.now() + BATCH_DRAIN_BUDGET_MS`. Each drain: `Math.min(PER_ITEM_DRAIN_MAX_MS, batchDrainDeadline - Date.now())`. Bounds total drain across entire batch.

#### P3 — Tags on Memory (multiple files)
- `AddMemoryOptions.tags?: string[]`; Memory CREATE: `tags: $tags` (default `[]`)
- `HybridSearchResult.tags: string[]`; hydration: `coalesce(m.tags, []) AS tags`
- `addMemoriesSchema` gains `tags?: string[]`; SUPERSEDE path writes `SET m.tags`
- `searchMemorySchema` gains `tag?: string`; browse WHERE: `AND ANY(t IN coalesce(m.tags, []) WHERE toLower(t) = toLower($tag))`; search: post-filter on `r.tags`

#### MCP-01 — Browse-mode Param Safety (lib/mcp/server.ts)
Browse mode was passing `{ userId, category: undefined }`. Now builds `browseParams` conditionally — `category` and `tag` only added when truthy.

#### ENTITY-01 — Tier 1 UNWIND Batch (lib/entities/worker.ts)
Added UNWIND Tier 1 query before per-entity `resolveEntity()` loop:
```cypher
UNWIND $normNames AS normName
MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
WHERE e.normalizedName = normName
RETURN normName, e.id AS entityId
```
Tier 1 hits use cached `entityId`; only misses call full `resolveEntity()`.

### Files Modified
1. `lib/db/memgraph.ts` — `runTransaction()`
2. `lib/memory/write.ts` — `tags` on `AddMemoryOptions` + Memory node
3. `lib/search/hybrid.ts` — `HybridSearchResult.tags` + hydration Cypher
4. `app/api/v1/memories/route.ts` — UNWIND batch replaces two N+1 loops
5. `lib/mcp/server.ts` — drain budget, tags schema+filter, browse param fix
6. `lib/entities/worker.ts` — Tier 1 UNWIND + local `normalizeName`
7. `tests/unit/mcp/tools.test.ts` — `tags: []` on two `HybridSearchResult` mocks
8. `tests/unit/entities/worker.test.ts` — WORKER_01 gains third `mockRunRead` for Tier 1

### Verification
- `tsc --noEmit`: 1 pre-existing error only
- `jest --runInBand`: 368 tests, 47 suites, 0 failures

---

## Session 19 — Test Coverage for Session 18 Fixes

### Objective
Add unit tests for every Session 18 fix. Verified 384/384 tests pass.

### Tests Added

#### tests/unit/memgraph.test.ts
- **MG_TX_01**: `runTransaction` executes all steps, commits, returns deserialized rows (string values to avoid neo4j integer wrapping)
- **MG_TX_02**: rolls back when a step throws; commit NOT called
- **MG_TX_03**: closes session even when commit throws
- Added `mockTx = { run, commit, rollback }` + `beginTransaction` to `mockSession`

#### tests/unit/memory/write.test.ts
- **WR_12**: `addMemory` passes tags array in CREATE params
- **WR_13**: `addMemory` defaults tags to `[]` when none provided

#### tests/unit/entities/worker.test.ts
- **WORKER_06**: Tier 1 UNWIND hit → `resolveEntity` NOT called; cached entityId used
- **WORKER_07**: Tier 1 miss → `resolveEntity` called as fallback

#### tests/unit/routes/memories-batch-categories.test.ts (new file)
- **ROUTE_CAT_01**: list path — 3 memories → ONE UNWIND+HAS_CATEGORY query; categories distributed correctly
- **ROUTE_CAT_02**: search path — N results → ONE UNWIND query
- **ROUTE_CAT_03**: category filter — only matching memories returned
- **ROUTE_CAT_04**: empty list — no UNWIND query issued

#### tests/unit/mcp/tools.test.ts (new describe blocks)
- **MCP_TAG_01**: `add_memories(tags:[...])` passes tags to `addMemory` AND writes `SET m.tags`
- **MCP_TAG_02**: `search_memory(tag:...)` filters case-insensitively
- **MCP_TAG_03**: browse with tag → `runRead` params/Cypher contain tag filter
- **MCP_BROWSE_NO_UNDEF_PARAMS**: browse without tag/category → no undefined keys in `runRead` params
- **MCP_ADD_DRAIN_GLOBAL_BUDGET**: 5-item batch with hanging extractions completes once 12s budget exhausted

### Bugs Found During Test Writing
1. `buildPageResponse` returns `{ items }` not `{ results }` — route test assertions updated.
2. `makeRecord({ a: 1 })` wraps as `{ low, high, toNumber }` — MG_TX_01 switched to string values.
3. `jest.clearAllMocks()` does NOT clear `specificReturnValues` queue — added `mockRunRead.mockReset()` in new `beforeEach` blocks.

### Verification
- `jest --runInBand --no-coverage`: **384 tests, 48 suites, 0 failures**
- `tsc --noEmit`: 1 pre-existing error only
