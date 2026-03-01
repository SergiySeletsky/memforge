# MemForge UI â€” Agent Log

---

## Completed Sessions (Summary)

| Sessions | Topic | Outcome |
|----------|-------|---------|
| 7 â€” Agentic Architect Audit (MemForge LTM) | Full repo audit using MemForge MCP as LTM across 10 code layers | 37 findings stored across 8 batches; 2 SUPERSEDE events from dedup. MCP report below. |
| 1 â€” Workspace Setup | Windows pnpm config, shamefully-hoist, onlyBuiltDependencies | `shamefully-hoist=true` in `.npmrc`; `onnxruntime-node` + `onnxruntime-web` in workspace-root `pnpm.onlyBuiltDependencies` |
| 2 â€” KuzuDB Spike | Embedded graph DB as Memgraph alternative | KuzuDB 2Ã— faster inserts, Memgraph 6Ã— faster search; KEPT Memgraph. Patterns: `getAll()` is async; `FLOAT[]` not `FLOAT[n]`; `JSON_EXTRACT` needs extension; inline vector literals (no `$q` param in similarity) |
| 3 â€” Full Pipeline Benchmark | End-to-end benchmark vs OSS baseline | Azure embedding sep=0.492, nomic sep=0.289; Azure retained as primary |
| 4â€“5 â€” MCP Eval V3 + Gap Fixes | 9.0/10 eval + fix BM25/dedup/delete-cascade | Entity identity = `(userId, toLower(name))` only; dedup threshold 0.85â†’0.75; RRF confidence threshold 0.02 |
| 8â€“9 (first) â€” V4/V5 Evals | `confident` field, alias resolution | Added `confident: boolean`; alias dedup resolved; `text_search.search_all()` not `search()` |
| 10â€“11 â€” MCP API surface | `add_memoryâ†’add_memories`; list_memories absorption | `list_memories` collapsed into `search_memory` browse mode (no query = paginated list) |
| 12 (first) â€” Entity Fragmentation | Duplicate entity nodes for same real-world entity | `normalizeName()` (lowercase + strip whitespace/punctuation); `normalizedName` stored in DB; semantic dedup via `entity_vectors` cosine threshold 0.88 + LLM confirmation; open ontology (UPPER_SNAKE_CASE types) |
| 13 (first) â€” Embedding Abstraction | Provider router: Azure vs nomic | `lib/embeddings/openai.ts` = provider router; startup health check in `instrumentation.ts`; silent null embeddings fixed |
| 14â€“21 â€” Embedding Benchmarks | 12+ providers across 6 test suites (Qwen3, mxbai, Arctic, Gemma, Stella, intelli-embed) | **Production**: azure (sep=0.492). **Best offline**: arctic-l-v2 (sep=0.469, 570 MB, 9.3 ms). **Best memory-holistic local**: mxbai (sep=0.432). **Selected provider**: `intelli-embed-v3` (custom arctic-embed-l-v2 finetune, 1024-dim INT8 ONNX, ~11 ms, beats Azure on dedup + negation safety). All providers fail dedupGap>0.15; BM25 negation gate required. |
| 22â€“25 â€” MTEB + Negation Safety | Submitted intelli-embed-v3; negation gate; Azure dedup threshold | BM25 lexical negation pre-filter added to dedup pipeline; Azure dedup threshold lowered to 0.55 |
| 12 (second) â€” Reliability Hardening | Tantivy writer killed + connection errors | `withRetry()`, `globalThis.__memgraphDriver`, `EXTRACTION_DRAIN_TIMEOUT_MS=3000`, atomic writes (2 queries not 4), `runRead` for read-only lookups |
| 13 (second) â€” Architectural Audit | 34 findings across all layers | Fixed `invalidAt: null` Cypher null literal bug; 7 HIGH findings documented in AUDIT_REPORT_SESSION13.md |
| 14 (second) â€” Lint Analysis | 100+ lint warnings | Resolved import/type issues; no new patterns |
| 15 â€” Frontend + API Audit | 22 new findings; 8 HIGH (frontend) | Stale closure, namespace violation, N+1 categorize documented in AUDIT_REPORT_SESSION15.md |
| 13 â€" Graphiti-Inspired Enhancements | P0â€"P3: temporal edges, entity summaries, fast-path dedup, context injection | Bi-temporal edges + contradiction LLM, entity profile gen, fast-path normalized dedup, previous-memory context for extraction. 46 suites / 418 tests. |
| 14 â€" Agentic Architect Audit (MCP LTM) | Full repo audit across 8 code layers using MCP as LTM | 24 findings stored (20 ADD, 4 SUPERSEDE); 6 MCP recovery tests; MCP tool evaluation report below. |
| 16 â€" Claimify-Inspired Fact Quality | Self-containment + atomic decomposition in extract-facts | Pronoun resolution, temporal resolution, compound fact splitting in user + agent prompts. 48 suites / 434 tests. |
| 17 â€" Agentic Architect Audit (MCP LTM) | Full repo audit across 6 layers using MCP as LTM | 16 findings stored (14 ADD, 2 SUPERSEDE); 6 MCP improvement opportunities identified. |
| 18 â€" MCP Improvements (6 features) | Implement 6 audit findings from Session 17 | updated_at, total_matching, tag_filter_warning, suppress_auto_categories, SUPERSEDE provenance, intra-batch dedup. 49 suites / 480 tests. |
| 19 â€" MCP Description Rewrite + Audit | Intent-driven tool descriptions + live audit testing Session 18 features | 11 findings stored; 4/6 Session 18 features verified live; 5 recovery tests (0.96â€"0.99 relevance). |

**Test baseline after completed sessions:** 480 tests, 49 suites, 0 failures

---

## Patterns & Architectural Decisions

### Cypher / Memgraph

```cypher
-- ALWAYS anchor to User node (Spec 09 namespace isolation)
MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memId})
-- NEVER: MATCH (m:Memory {id: $memId})   â† violates namespace isolation

-- UNWIND batch replaces N+1 sequential queries
UNWIND $ids AS memId
MATCH (m:Memory {id: memId})-[:HAS_CATEGORY]->(c:Category)
RETURN memId AS id, c.name AS name

-- Conditional param building â€” never pass undefined to runRead/runWrite
const params: Record<string, unknown> = { userId, offset, limit };
if (category) params.category = category;   // âœ…
// NOT: { userId, category: undefined }     // âŒ Memgraph logs unused-param warning

-- Null literals rejected in CREATE
CREATE (m:Memory { content: $content })     -- âœ…  omit invalidAt â€” absent = semantically null
CREATE (m:Memory { invalidAt: null })       -- âŒ  Memgraph rejects null literal in property map
```

**SKIP/LIMIT**: Always use `wrapSkipLimit()` helper â€” auto-rewrites to `toInteger()` for Memgraph compatibility. Never bare integer literals.

**`runTransaction()`**: For 2+ writes that must be atomic â€” single Bolt write transaction with auto-rollback.

**Bi-temporal reads**: Live memories filter `WHERE m.invalidAt IS NULL`. Edits call `supersedeMemory()`. Never in-place UPDATE for user-visible changes.

**Entity merge key**: `(userId, normalizeName(name))` only â€” type is metadata, not identity. `normalizeName()` = lowercase + strip `[\s\-_./\\]+`.

**Cypher string concat precedence**: Parenthesize string concat in `STARTS WITH` checks â€” Memgraph operator precedence differs from Neo4j.

**`text_search.search_all()`**: Use instead of `text_search.search()` for BM25 full-text queries.

### Driver / Connection

```typescript
// globalThis singleton survives Next.js HMR (lib/db/memgraph.ts)
if (!globalThis.__memgraphDriver) globalThis.__memgraphDriver = neo4j.driver(url, auth, opts);

// withRetry wraps all runRead/runWrite â€” exponential backoff, 3 attempts, 300 ms base
// Transient errors trigger retry + driver invalidation:
// "Connection was closed by server", "Tantivy error", "index writer was killed",
// "ServiceUnavailable", "ECONNREFUSED", "ECONNRESET"
```

Pool config: `maxConnectionPoolSize: 25`, `connectionAcquisitionTimeout: 10_000`.
Memgraph 3.x: `encrypted: false` in neo4j driver options.
`--experimental-enabled=text-search` required for BM25/Tantivy.

### Write Pipeline

**Tantivy write contention**: Fire-and-forget `processEntityExtraction` from item N running when item N+1 writes â†’ concurrent Tantivy writers panic. Fix: drain prior extraction promise before each write (`Promise.race([prev, timeout(3000)])`).

**Worker Tier 1 batch**: Single UNWIND resolves all `normalizedName` exact matches before falling back to full `resolveEntity()` per entity.

**Tags vs Categories**:
- `tags` = exact caller-controlled identifiers (`string[]` on Memory node); passed by caller; scoped retrieval
- `categories` = semantic LLM-assigned labels (`:Category` nodes via `[:HAS_CATEGORY]`); assigned async

**Global drain budget** (`add_memories` handler):
```typescript
const batchDrainDeadline = Date.now() + BATCH_DRAIN_BUDGET_MS; // 12_000
const drainMs = Math.min(PER_ITEM_DRAIN_MAX_MS, batchDrainDeadline - Date.now());
```

**`classifyIntent` fail-open**: Wrap in its own try/catch with STORE fallback â€” outer write-pipeline catch converts errors to ERROR events (memory lost).

**`normalizeName` in worker.ts**: Defined locally, not imported from `resolve.ts`. jest auto-mock returns `undefined` for imported functions; define pure utilities locally to avoid mock interference.

### LLM / Embedding

- `getLLMClient()` from `lib/ai/client.ts` â€” singleton, auto-selects Azure or OpenAI. Model: `LLM_AZURE_DEPLOYMENT ?? MEMFORGE_CATEGORIZATION_MODEL ?? "gpt-4o-mini"`.
- `embed()` from `lib/embeddings/intelli.ts` â€” default: `serhiiseletskyi/intelli-embed-v3` (1024-dim INT8 ONNX, ~11 ms, no API key). Falls back to Azure when `EMBEDDING_AZURE_*` env is set.
- **Mock LLM in tests**: mock `@/lib/ai/client`, NOT the `openai` package â€” Azure credential check fires before `new OpenAI()`.
- **`embedDescriptionAsync`** is fire-and-forget + calls `runWrite`. Use `mockResolvedValueOnce` (not `mockResolvedValue`) so second embed call uses the default rejected state.
- Fire-and-forget calls: always `.catch(e => console.warn(...))` â€” never throw into write pipeline.
- Provider switch = re-index: drop + recreate Memgraph vector indexes on dimension change.

### Testing

**`jest.clearAllMocks()` does NOT clear `specificReturnValues` queue** (`mockReturnValueOnce` / `mockResolvedValueOnce`). Use `mockFn.mockReset()` in `beforeEach` of new describe blocks to drain orphaned Once values from prior blocks.

**`makeRecord()` integer wrapping**: `makeRecord({ key: intValue })` â†’ `{ low, high, toNumber }`. Use string values when asserting `toEqual` on deserialized rows.

**`buildPageResponse` shape**: Returns `{ items, total, page, size, pages }`. Always use `body.items`, NOT `body.results`.

**`globalThis` test isolation**: Set `globalThis.__memgraphDriver = null` in `beforeEach` when testing driver creation â€” globalThis persists across `jest.resetModules()`.

**Generic type args on `require()`**: TS2347 â€” annotate the result variable instead of `<T>` on the require call.

### Infrastructure

- Windows + pnpm: `shamefully-hoist=true` in `.npmrc` â€” prevents webpack drive-letter casing bug.
- `pnpm.onlyBuiltDependencies` only takes effect in workspace root `package.json`.
- ESM packages in Next.js: add to both `serverExternalPackages` and webpack `externals`.
- Schema init: `instrumentation.ts` â†’ `initSchema()` on server start (idempotent). No manual migration.
- RRF confidence threshold 0.02 = above single-arm `1/(K+1)` where K=60 (~0.016).
- BM25 is essential for short-queryâ†’long-memory separation; pure vector search insufficient.
- Negation safety: dense cosine cannot distinguish negations (negGap â‰ˆ 0 for all models); use BM25 lexical pre-filter before cosine dedup commits.

---

## Known Pre-existing Issues

All previously documented pre-existing issues have been resolved:

| ID | Status | Resolution |
|----|--------|------------|
| TS-001 | FIXED (Session 12) | Removed `export { activeTransports }` re-export from SSE route file — Next.js route modules must only export handlers |
| TEST-001 | FIXED (prior session) | All 19 resolve.test.ts tests pass — semantic dedup tests are fully mocked, no live Memgraph needed |
| E2E-001 | N/A | E2E tests excluded from `pnpm test` via jest.config.ts `testMatch` (Session 5); run separately via `pnpm test:e2e` |

---

## Session 16 â€” 2-Tool MCP Architecture Refactor

### Objective
Collapse 10-tool MCP API to 2 tools (`add_memories` + `search_memory`) with server-side intent classification and entity-aware search enrichment. Prior 3 audit sessions used only `search_memory` (5 calls) + `add_memories` (17 calls) â€” 8 tools had zero usage.

### Architecture Change

**Before:** 10 tools â€” `add_memories`, `search_memory`, `update_memory`, `search_memory_entities`, `get_memory_entity`, `get_related_memories`, `get_memory_map`, `create_memory_relation`, `delete_memory_relation`, `delete_memory_entity`

**After:** 2 tools â€” `add_memories` (writes + intent classification) + `search_memory` (reads + entity enrichment)

**Intent classification (`classifyIntent`)**:
1. Fast regex pre-filter `mightBeCommand()` â€” skips LLM for obvious facts
2. LLM fallback â€” structured JSON prompt: `STORE | INVALIDATE | DELETE_ENTITY`
3. Fail-open: any error â†’ `STORE` (isolated try/catch, separate from write-pipeline catch)

**Entity enrichment in `search_memory`**: `searchEntities(query, userId, { limit: 5 })` auto-enriches results; best-effort; `include_entities` param (default `true`).

### Files Changed
1. `lib/mcp/classify.ts` (new, ~105 lines) â€” intent classifier
2. `lib/mcp/entities.ts` (new, ~230 lines) â€” `searchEntities`, `invalidateMemoriesByDescription`, `deleteEntityByNameOrId`
3. `lib/mcp/server.ts` â€” rewritten 1234 â†’ ~430 lines; removed 8 tools; version `2.0.0`
4. `tests/unit/mcp/tools.test.ts` â€” removed 8 deprecated blocks; added MCP_ADD_09/10/11, MCP_SM_05/06

### Bugs Fixed During Implementation
1. `classifyIntent` threw inside outer try/catch â†’ memory became ERROR event (lost). Fix: isolated try/catch with STORE fallback.
2. PowerShell `Set-Content -Encoding utf8` corrupted multi-byte UTF-8. Fix: delete + recreate file with `create_file`.
3. Orphaned `mockResolvedValueOnce` from MCP_ADD_11 leaked into drain tests. Fix: fail-open server fix consumed the mock.

### Type Contract Notes
- `invalidateMemoriesByDescription` returns `Array<{id, content}>`, not a count
- `DeleteEntityResult.entity` is a `string` (name), not an object
- `HybridSearchResult`: `rrfScore` (not `score`), `categories`/`appName`/`createdAt` (no `updatedAt`)
- `EntityProfile.relationships`: all four fields required â€” `source`, `type`, `target`, `description`

### Verification
- `tsc --noEmit`: 2 pre-existing errors only
- `jest --runInBand`: 315 tests, 45 suites, 0 failures

---

## Session 18 â€” Audit Findings Implementation (P1â€“P3)

### Objective
Implement 6 findings from the Session 17 architect audit.

### Changes Made

#### DB-01 â€” `runTransaction()` (lib/db/memgraph.ts)
`runTransaction(steps: Array<{cypher, params?}>): Promise<T[][]>` â€” multiple Cypher statements in a single Bolt write transaction with auto-rollback. Wrapped with `withRetry()`.

#### API-01 â€” Eliminate N+1 Category Fetch (app/api/v1/memories/route.ts)
Both `GET /api/v1/memories` code paths had a per-memory `runRead` in a `for` loop. Replaced with:
```cypher
UNWIND $ids AS memId
MATCH (m:Memory {id: memId})-[:HAS_CATEGORY]->(c:Category)
RETURN memId AS id, c.name AS name
```
`Map<id, string[]>` built once; loop does O(1) lookups.

#### MCP-02 â€” Global Drain Budget (lib/mcp/server.ts)
Added `BATCH_DRAIN_BUDGET_MS = 12_000` and `batchDrainDeadline = Date.now() + BATCH_DRAIN_BUDGET_MS`. Each drain: `Math.min(PER_ITEM_DRAIN_MAX_MS, batchDrainDeadline - Date.now())`. Bounds total drain across entire batch.

#### P3 â€” Tags on Memory (multiple files)
- `AddMemoryOptions.tags?: string[]`; Memory CREATE: `tags: $tags` (default `[]`)
- `HybridSearchResult.tags: string[]`; hydration: `coalesce(m.tags, []) AS tags`
- `addMemoriesSchema` gains `tags?: string[]`; SUPERSEDE path writes `SET m.tags`
- `searchMemorySchema` gains `tag?: string`; browse WHERE: `AND ANY(t IN coalesce(m.tags, []) WHERE toLower(t) = toLower($tag))`; search: post-filter on `r.tags`

#### MCP-01 â€” Browse-mode Param Safety (lib/mcp/server.ts)
Browse mode was passing `{ userId, category: undefined }`. Now builds `browseParams` conditionally â€” `category` and `tag` only added when truthy.

#### ENTITY-01 â€” Tier 1 UNWIND Batch (lib/entities/worker.ts)
Added UNWIND Tier 1 query before per-entity `resolveEntity()` loop:
```cypher
UNWIND $normNames AS normName
MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
WHERE e.normalizedName = normName
RETURN normName, e.id AS entityId
```
Tier 1 hits use cached `entityId`; only misses call full `resolveEntity()`.

### Files Modified
1. `lib/db/memgraph.ts` â€” `runTransaction()`
2. `lib/memory/write.ts` â€” `tags` on `AddMemoryOptions` + Memory node
3. `lib/search/hybrid.ts` â€” `HybridSearchResult.tags` + hydration Cypher
4. `app/api/v1/memories/route.ts` â€” UNWIND batch replaces two N+1 loops
5. `lib/mcp/server.ts` â€” drain budget, tags schema+filter, browse param fix
6. `lib/entities/worker.ts` â€” Tier 1 UNWIND + local `normalizeName`
7. `tests/unit/mcp/tools.test.ts` â€” `tags: []` on two `HybridSearchResult` mocks
8. `tests/unit/entities/worker.test.ts` â€” WORKER_01 gains third `mockRunRead` for Tier 1

### Verification
- `tsc --noEmit`: 1 pre-existing error only
- `jest --runInBand`: 368 tests, 47 suites, 0 failures

---

## Session 19 â€” Test Coverage for Session 18 Fixes

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
- **WORKER_06**: Tier 1 UNWIND hit â†’ `resolveEntity` NOT called; cached entityId used
- **WORKER_07**: Tier 1 miss â†’ `resolveEntity` called as fallback

#### tests/unit/routes/memories-batch-categories.test.ts (new file)
- **ROUTE_CAT_01**: list path â€” 3 memories â†’ ONE UNWIND+HAS_CATEGORY query; categories distributed correctly
- **ROUTE_CAT_02**: search path â€” N results â†’ ONE UNWIND query
- **ROUTE_CAT_03**: category filter â€” only matching memories returned
- **ROUTE_CAT_04**: empty list â€” no UNWIND query issued

#### tests/unit/mcp/tools.test.ts (new describe blocks)
- **MCP_TAG_01**: `add_memories(tags:[...])` passes tags to `addMemory` AND writes `SET m.tags`
- **MCP_TAG_02**: `search_memory(tag:...)` filters case-insensitively
- **MCP_TAG_03**: browse with tag â†’ `runRead` params/Cypher contain tag filter
- **MCP_BROWSE_NO_UNDEF_PARAMS**: browse without tag/category â†’ no undefined keys in `runRead` params
- **MCP_ADD_DRAIN_GLOBAL_BUDGET**: 5-item batch with hanging extractions completes once 12s budget exhausted

### Bugs Found During Test Writing
1. `buildPageResponse` returns `{ items }` not `{ results }` â€” route test assertions updated.
2. `makeRecord({ a: 1 })` wraps as `{ low, high, toNumber }` â€” MG_TX_01 switched to string values.
3. `jest.clearAllMocks()` does NOT clear `specificReturnValues` queue â€” added `mockRunRead.mockReset()` in new `beforeEach` blocks.
4. `jest.clearAllMocks()` does NOT flush `mockResolvedValueOnce` queues â€” queue items leak to subsequent tests. In `RESOLVE_DUP_SAFE` a second `mockRunRead.mockResolvedValueOnce([])` was queued for an alias lookup that never fires for CONCEPT type; the leftover item corrupted `RESOLVE_READ_ONLY`. Fix: only queue the exact number of Once values that will actually be consumed.

### Verification
- `jest --runInBand --no-coverage`: **384 tests, 48 suites, 0 failures**
- `tsc --noEmit`: 1 pre-existing error only

---

## Session 3 â€” Entity Dedup Fix + Test Coverage Completion (2026-02-27)

### ENTITY-DUP-FIX â€” Duplicate Entity nodes under concurrent extraction

**Root cause:** `lib/entities/resolve.ts :: resolveEntity()` used a `READ â†’ CREATE` pattern (TOCTOU race). Two concurrent `processEntityExtraction()` calls for different memories containing the same entity could both read "not found" and both `CREATE` a new Entity node. The unique constraint was on `Entity.id` (UUID) â€” not on `(normalizedName, userId)` â€” so duplicates were silently allowed.

**Fix in `lib/entities/resolve.ts`:**
- Changed the `else` branch (new entity creation) from `CREATE (e:Entity {...}) CREATE (u)-[:HAS_ENTITY]->(e)` to a single atomic MERGE:
  ```cypher
  MERGE (u)-[:HAS_ENTITY]->(e:Entity {normalizedName: $normalizedName, userId: $userId})
  ON CREATE SET e.id = $id, e.name = $name, ...
  RETURN e.id AS entityId
  ```
- Memgraph acquires an exclusive lock on the edge pattern during MERGE, so concurrent callers for the same entity produce exactly one node.
- The returned `e.id` is used (not the pre-generated UUID) â€” handles the race where a concurrent writer created the node before us.

**Supplementary fix in `lib/db/memgraph.ts`:**
- Added `CREATE INDEX ON :Entity(userId)` so the MERGE lookup on `{normalizedName, userId}` is covered by indexes on both properties.

**New tests:**
- `RESOLVE_DUP_SAFE`: verifies MERGE returns the concurrent writer's entityId (not our pre-generated UUID)
- `RESOLVE_ATOMIC`: updated comment to reflect MERGE (was CREATE), assertions still pass since `ON CREATE SET` contains the literal "CREATE"

### Additional test coverage for 11 audit fixes (same session)

New tests added (all passing):
| Test | File | Fix covered |
|------|------|-------------|
| `WR_34` | write.test.ts | WRITE-04: supersedeMemory inherits tags via runRead |
| `WR_35` | write.test.ts | WRITE-04: explicit tags bypass runRead |
| `WR_36` | write.test.ts | WRITE-04: missing tags fall back to [] |
| `MCP_SM_04` (upgraded) | tools.test.ts | ACCESS-LOG-01: MERGE + accessCount asserted |
| `MCP_TAG_SUPERSEDE` | tools.test.ts | WRITE-04: tags forwarded as 5th arg on supersede path |
| `MCP_FILTER_FETCH_01-03` | tools.test.ts | MCP-FILTER-01: 3Ã— topK when filters active |
| `ORCH_09` | dedup-orchestrator.test.ts | DEDUP-01: intelliThreshold independent from azureThreshold |

### Verification
- `jest --runInBand --no-coverage`: **393 tests, 48 suites, 0 failures**
- `tsc --noEmit`: pre-existing errors only

---

## Session 4 ï¿½ Architectural Audit (MCP LTM Workflow) (2026-05-31)

### Objective
Full read-only audit of current codebase state using MemForge MCP as long-term memory. Identify new findings post-Session-3 fixes. Evaluate MCP tool utility as an active agent workflow aid.

### New Findings (10 identified)

| ID | File | Description | Severity |
|----|------|-------------|----------|
| MCP-SUPERSEDE-TAG-01 | lib/mcp/server.ts | Dead-code redundant SET m.tags runWrite after supersedeMemory already writes tags as 5th arg | low-perf |
| HYBRID-HYDRATE-01 | lib/search/hybrid.ts L89 | Hydration query missing WHERE m.invalidAt IS NULL guard | medium-correctness |
| MCP-RERANK-01 | lib/mcp/server.ts | cross_encoder/mmr rerank not exposed in search_memory MCP schema | feature-gap |
| WORKER-SCOPE-01 | lib/entities/worker.ts L29 | Step 1 reads Memory without User anchor - Spec 09 violation | low-security |
| ENTITY-ENRICH-N+1 | lib/mcp/entities.ts L148 | Relationship fetch per-entity in serial for-loop (N+1) | medium-perf |
| API-SEARCH-PAGINATE-01 | app/api/v1/memories/route.ts L52 | topK: size * page insufficient for deep pagination | medium-correctness |
| INVALIDATE-SEQUENTIAL-01 | lib/mcp/entities.ts L196 | deleteMemory called in for-loop per match - should batch | low-perf |
| CONFIG-SAVE-01 | lib/config/helpers.ts L54 | saveConfigToDb sequential runWrite per key | low-perf |
| TRANSACT-SUPERSEDE-01 | lib/memory/write.ts | Two separate runWrite calls for invalidate-old + create-new not atomic | medium-correctness |
| CLASSIFY-GAP-01 | lib/mcp/classify.ts | COMMAND_PATTERNS missing clear/wipe/stop-knowing variants | low-ux |

### MCP Tool Utility (Session 4)
- add_memories: 1 call (10 items) - 2 stored, 8 errored (auth failure after rate limit)
- search_memory: 1 call (browse) - 0 results (fresh store); 1 call (query) - 0 results (nothing stored)
- Key observation: add_memories auth errors after first batch of 10 items is a reliability gap

### Verification
- Unit tests: 337 tests, 38 suites, 0 failures (e2e require live server - normal)
- tsc --noEmit: pre-existing errors only; no regressions


---

## Session 4 - Architectural Audit (MCP LTM Workflow) (2026-05-31)
New findings: MCP-SUPERSEDE-TAG-01, HYBRID-HYDRATE-01, MCP-RERANK-01, WORKER-SCOPE-01, ENTITY-ENRICH-N+1, API-SEARCH-PAGINATE-01, INVALIDATE-SEQUENTIAL-01, CONFIG-SAVE-01, TRANSACT-SUPERSEDE-01, CLASSIFY-GAP-01. Unit tests: 337/337 pass.


---

## Session 5 - Systemic Reliability Fixes (2026-02-27)

Root cause: server started from workspace root (no .env loaded) -> Memgraph auth failure -> all API 500s.

Fixes applied:
1. instrumentation.ts: Added Memgraph connectivity probe (RETURN 1 AS probe) BEFORE initSchema. On auth failure: big warning banner with URL/user/actionable instructions + mentions wrong directory.
2. jest.config.ts: Excluded e2e from default testMatch (only unit/, baseline/, security/). pnpm test now 100% deterministic without a live server.
3. app/api/health/route.ts: New /api/health endpoint - checks Memgraph + embeddings, returns {status:'ok'|'degraded', checks:{memgraph,embeddings}} with latency.
4. root package.json: Added dev/build/test/test:e2e scripts delegating to MemForge/ui so pnpm dev from repo root works.

Verification:
- pnpm test (unit): 37 suites / 320 tests - PASS (no server needed)
- pnpm test:e2e: 11 suites / 73 tests - PASS (requires live server + Memgraph)
- GET /api/health: {status:'ok', memgraph:{ok:true,latency:3ms}, embeddings:{ok:true,provider:'intelli',dim:1024,latency:1067ms}}
- tsc --noEmit: pre-existing errors only

---

## Session 6 â€” MCP Agentic Audit (fresh Memgraph)

**Setup:** User cleared Memgraph. All data wiped, schema reset. Agent used MemForge MCP as LTM throughout the audit.

**MCP-BROWSE-SLICE-01 (FIXED):** First MCP call post-clear failed: `Expected an integer for a bound in list slicing, got double`. `lib/mcp/server.ts` L321 used `allMems[$offset..($offset+$limit)]` â€” Bolt sends JS numbers as float64, Memgraph requires integer bounds for list slices. `wrapSkipLimit()` only patches `SKIP/LIMIT` keywords. Fix: `allMems[toInteger($offset)..(toInteger($offset)+toInteger($limit))]`. Server hot-reload didn't pick up SSE route change â€” had to kill PID 25120 and restart.

**Findings found + fixed this session (6 fixes, 37 suites / 320 tests pass):**

| ID | Severity | File | Fix |
|----|----------|------|-----|
| FILTER-BITEMPORAL-01 | HIGH | filter/route.ts | Added `m.invalidAt IS NULL` to default whereParts |
| BACKUP-EXPORT-NO-AUTH-01 | HIGH | backup/export/route.ts | Require user_id, scope query per user + added invalidAt IS NULL |
| CATEGORIZE-N-WRITE-01 | MEDIUM-PERF | lib/memory/categorize.ts | Replaced N sequential runWrite with single UNWIND batch |
| BULK-NO-APP-01 | MEDIUM | lib/memory/bulk.ts | Added App MERGE + [:CREATED_BY] to UNWIND CREATE |
| BULK-NO-CATEGORIZE-01 | LOW | lib/memory/bulk.ts | Added fire-and-forget categorizeMemory() per bulk item |
| APPS-COUNT-BITEMPORAL-01 | LOW | apps/route.ts + apps/[appId]/route.ts | Added `m.invalidAt IS NULL` to memory_count queries |

**Open findings (not yet fixed, documented in MemForge store):**
- CLUSTER-ISOLATION-01 (HIGH): community_detection.get() runs on all-users graph
- CLUSTER-UNANCHORED-01: cluster build MATCH Memory without User anchor
- CONFIG-SAVE-01: setConfig sequential writes (N round-trips)
- APPS-APP-ISOLATION-01: apps/[appId] no User anchor on App lookup
- FILTER-FULLSCAN-01: filter uses toLower CONTAINS instead of hybridSearch

**Carryover findings from Session 4 (still pending):**
- MCP-SUPERSEDE-TAG-01, HYBRID-HYDRATE-01, MCP-RERANK-01, WORKER-SCOPE-01,
  ENTITY-ENRICH-N+1, API-SEARCH-PAGINATE-01, INVALIDATE-SEQUENTIAL-01,
  TRANSACT-SUPERSEDE-01, CLASSIFY-GAP-01

**Test baseline after session 6:** 37 suites / 320 tests â€” PASS

---

## Session 9 â€” OSS Migration to MemForge (Phase 1+2)

### Migration Execution

Migrated 5 features from `memforge-ts/src/oss/src/` â†’ `MemForge/ui/lib/`, covering Phase 1 + Phase 2 of MIGRATION_PLAN.md.

**New files created (6):**

| File | Source | Purpose |
|------|--------|---------|
| `lib/memory/extract-facts.ts` | `oss/prompts/index.ts` | LLM fact extraction from conversations (user/agent modes) |
| `lib/entities/tools.ts` | `oss/graphs/tools.ts` | OpenAI function-calling tool definitions for entity/relation extraction |
| `lib/graph/prompts.ts` | `oss/graphs/utils.ts` | Knowledge graph lifecycle prompts (extract/update/delete) |
| `lib/graph/types.ts` | `oss/graph_stores/base.ts` | GraphStore interface + data types |
| `lib/graph/memgraph.ts` | `oss/graph_stores/memgraph.ts` | MemgraphGraphStore implementation (~480 lines, fully rewritten for runRead/runWrite) |
| `lib/memory/history.ts` | `oss/storage/base.ts` + `MemgraphHistoryManager.ts` | Memory audit trail (ADD/SUPERSEDE/DELETE/ARCHIVE/PAUSE) |

**New test files (6, 52 tests total):**

| Test File | Tests |
|-----------|-------|
| `tests/unit/memory/extract-facts.test.ts` | 9 |
| `tests/unit/entities/tools.test.ts` | 9 |
| `tests/unit/graph/prompts.test.ts` | 6 |
| `tests/unit/graph/types.test.ts` | 7 |
| `tests/unit/graph/memgraph.test.ts` | 14 |
| `tests/unit/memory/history.test.ts` | 7 |

**Pipeline integration:**
- `lib/memory/write.ts`: Added `addHistory()` fire-and-forget calls to `addMemory`, `supersedeMemory`, `deleteMemory`, `archiveMemory`, `pauseMemory`
- `lib/db/memgraph.ts`: Added `CREATE INDEX ON :MemoryHistory(memoryId)` to `initSchema()`
- `tests/unit/memory/write.test.ts`: Added `@/lib/memory/history` mock to prevent false call-count failures

**Bug fix during migration:**
- `removeCodeBlocks()`: Changed regex from `/ ```[^`]*``` /g` (removes entire block including content) to `/```(?:\w*)\n?([\s\S]*?)```/g` (preserves content inside fences). This correctly handles LLM JSON output wrapped in markdown code blocks.

**oss files removed (9):**
- `prompts/index.ts`, `graphs/tools.ts`, `graphs/utils.ts`, `graphs/configs.ts`
- `graph_stores/base.ts`, `graph_stores/memgraph.ts`
- `storage/base.ts`, `storage/MemgraphHistoryManager.ts`, `storage/MemoryHistoryManager.ts`
- Empty dirs removed: `graphs/`, `prompts/`

### Test Results
- **43 suites / 376 tests â€” ALL PASS** (up from 37/320 baseline)
- **tsc --noEmit**: 1 pre-existing error only (.next/types MCP SSE route)

---

## Session 10 â€” OSS Migration Completion (Phase 3 + Final Cleanup)

### Migration Execution

Completed Phase 3 of MIGRATION_PLAN.md: Enhanced contradiction detection in dedup pipeline.
Deleted ALL remaining oss source files (48) and test files (18).

**Enhanced file (1):**

| File | What Changed |
|------|-------------|
| `lib/dedup/verifyDuplicate.ts` | Added few-shot examples from oss's `DEFAULT_UPDATE_MEMORY_PROMPT` to `VERIFY_PROMPT`. Now covers 7 example pairs: paraphraseâ†’DUPLICATE, detail enrichmentâ†’SUPERSEDES, preference changeâ†’SUPERSEDES, contradictionâ†’SUPERSEDES, unrelatedâ†’DIFFERENT, residence updateâ†’SUPERSEDES, dark mode paraphraseâ†’DUPLICATE. Exported `VERIFY_PROMPT` for test inspection. |

**Test files enhanced (2):**

| Test File | Tests Before | Tests After | New Scenarios |
|-----------|-------------|-------------|---------------|
| `tests/unit/dedup/verifyDuplicate.test.ts` | 6 | 14 | +8: paraphrase DUPLICATE, enriched detail SUPERSEDES, preference change SUPERSEDES, contradiction SUPERSEDES, unrelated DIFFERENT, prompt export, message structure, null response |
| `tests/unit/dedup/dedup-orchestrator.test.ts` | 9 | 13 | +4: negation gate blocks false DUPLICATE, symmetric no negation passes, SUPERSEDES exempted from gate, LLM error fail-open |

**oss files deleted (66 total):**
- 48 source files across 10 directories: `config/` (2), `embeddings/` (7), `graph_stores/` (2), `llms/` (14), `memory/` (3), `reranker/` (4), `storage/` (4), `types/` (1), `utils/` (6), `vector_stores/` (4), plus `index.ts`
- 18 test files: bm25, cohere, embedders, factory, graph_store_kuzu, graph_store_memgraph, llm-providers, llms, memgraph_history_integration, memory, memory_kuzu_graph_integration, memory_kuzu_integration, memory_memgraph_integration, memory_unit, reranker, storage, vector_store, vector_store_memgraph_integration
- 10 directories removed: `config/`, `embeddings/`, `graph_stores/`, `llms/`, `memory/`, `reranker/`, `storage/`, `types/`, `utils/`, `vector_stores/`
- Only scaffolding remains: `.env.example`, `.gitignore`, `package.json`, `README.md`, `tsconfig.json`

**Architecture decision:**
The oss two-phase pipeline (extract facts â†’ bulk compare against all memories via `getUpdateMemoryMessages()`) was evaluated but NOT ported. MemForge's existing architecture (intent classifier â†’ dedup pipeline â†’ pairwise verify) is architecturally superior for the Next.js monolith because:
1. It avoids the NÃ—M comparison matrix (N facts Ã— M memories) â€” MemForge does 1-to-1 pairwise with the closest vector match
2. The intent classifier + dedup pipeline separation is cleaner than the oss's monolithic `Memory.add()` orchestrator
3. Bi-temporal supersession (SUPERSEDES â†’ `supersedeMemory()`) handles contradictions better than oss's DELETE+ADD split

The prompt quality improvement was the only meaningful enhancement to port â€” few-shot examples make the LLM classification more reliable for edge cases (enrichment vs duplication vs contradiction).

### Test Results
- **43 suites / 388 tests â€” ALL PASS** (up from 43/376 session-9 baseline, +12 new tests)

---

## Session 7 â€” Agentic Architect Audit (Fresh Memgraph, MCP LTM Stress Test) (2026-02-28)

### Objective
Full read-only codebase audit using MemForge MCP as long-term storage across 10 code layers (DB, write pipeline, search, entity pipeline, MCP server, dedup, clusters, config, API routes, frontend). Memgraph was cleared fresh at session start. Audit was designed to exceed a single LLM context window â€” MCP was the only memory mechanism.

### MCP Tool Usage Statistics

| Tool | Calls | Items Sent | Items Stored | SUPERSEDE | Errors |
|------|-------|-----------|-------------|-----------|--------|
| `add_memories` | 10 | 41 | 37 | 2 | 0 |
| `search_memory` (browse) | 2 | â€” | â€” | â€” | â€” |
| **Total** | **12** | **41** | **37** | **2** | **0** |

### What Worked Well
1. **Batched writes (array form)**: `add_memories(content: [...])` was used for all writes â€” 4 items per call. Zero errors, all 10 calls succeeded. Much more efficient than 41 individual calls.
2. **Category + tag filtering**: Categories (`Architecture`, `Database`, `Refactoring`) and tags (`audit-session-7`, `db-layer`, `security`) allowed immediate grouping/filter on browse without re-fetching all 37 memories.
3. **Dedup caught overlapping findings**: Two CONFIG findings that shared semantic space were correctly collapsed (CONFIG-NO-TTL-CACHE-01 superseded a duplicate). REFACTOR-PRIORITY-HIGH finding about entity extraction also superseded a related detail-level finding. *This is the correct behavior â€” two similar architectural notes become one consolidated finding.*
4. **Browse as cold-start check**: Two `search_memory()` (no query) calls verified the store was empty at session start and fully populated at session end. Total count was readable at a glance from `total` field.
5. **Tag-scoped retrieval**: All audit findings tagged `audit-session-7` would be instantly filterable in a future session via `search_memory(tag: "audit-session-7")` without mixing with other stored memories â€” this is the key value-add over plain context.

### What Could Be Improved

1. **Dedup threshold too aggressive for structured findings**: Two distinct action items (sequential writes vs. missing TTL cache in config layer) were merged via SUPERSEDE because their embedding similarity exceeded the threshold. For audit/planning use cases where each finding is an independent action item, it would help to have a `dedup_mode: "strict"` option that raises the threshold to 0.90+ for single `add_memories` sessions.

2. **No `search_memory(tag: "...")` was tested for targeted retrieval**: All retrieval was browse-mode. A third use pattern â€” `search_memory(query: "security findings")` â€” was not exercised. This would be the primary recovery mechanism if context was lost mid-session. Should verify it works and returns tagged findings ranked by relevance.

3. **SUPERSEDE events swallow the superseded memory**: When CONFIG-NO-TTL-CACHE-01 superseded CONFIG-SAVE-SEQUENTIAL-01, the older finding is no longer in browse results. For an audit session this is a data loss â€” both findings represent distinct bugs. Workaround: use `categories` or `tags` to namespace overlapping findings before sending.

4. **No `search_memory` mid-session for context recovery was tested**: The intent was to simulate context overflow, but the auditor had the full code in context. True value would emerge when a new session picks up using `search_memory(query: "unfixed carryover findings")` to resume where the prior session left off â€” this pattern was not exercised.

5. **`add_memories` response is verbose**: The JSON result includes `id`, `memory`, `event` per item. For a batch of 4, parsing the response to verify all 4 were ADD (not SKIP or ERROR) requires parsing. A summary header â€” `{"stored": 4, "skipped": 0, "errors": 0, "results": [...]}` â€” would make batch validation easier.

6. **Category assignment is async (fire-and-forget)**: Findings stored with `categories: ["Architecture", "Database"]` sometimes got additional LLM-assigned categories (`Work`, `Technology`) visible on browse. These are useful but create inconsistency between what the caller set and what the LLM added. For structured audits, callers should use explicit `categories` to get predictable grouping, and expect additive LLM enrichment.

### Findings Stored (37 total across 10 layers)

| ID | Severity | Layer | Summary |
|----|----------|-------|---------|
| DB-SKIP-LIMIT-01 | LOW | DB | wrapSkipLimit double-wraps pre-existing toInteger() calls |
| DB-CLOSE-MISSING-01 | LOW | DB | closeDriver() not registered on SIGTERM/SIGINT |
| DB-VECTOR-VERIFY-STATUS-01 | MEDIUM | DB | _vectorIndexVerified not reset on Memgraph restart without connection drop |
| WRITE-ATOMIC-01 | MEDIUM | Write | supersedeMemory() 2 runWrite calls not atomic (no runTransaction) |
| WRITE-USER-MERGE-REDUNDANT-01 | LOW-PERF | Write | resolveEntity() merges User on every call (N times per memory) |
| WRITE-DELETE-NO-ENTITY-CASCADE-01 | MEDIUM | Write | deleteMemory does not re-evaluate RELATED_TO relationship support |
| WRITE-SUPERSEDE-MISSING-ENTITY-LINK-01 | HIGH | Write | supersedeMemory callers must trigger processEntityExtraction; function itself does not |
| SEARCH-HYDRATE-INVALIDAT-01 | MEDIUM | Search | hybrid.ts hydration query missing WHERE m.invalidAt IS NULL |
| SEARCH-VECTOR-SCOPE-01 | RESOLVED | Search | Confirmed vector.ts HAS the invalidAt guard â€” not a finding |
| SEARCH-PAGINATION-01 | MEDIUM | Search | Deep pagination is O(nÃ—page); no backfill when post-filters remove results |
| SEARCH-TEXT-ARM-ERRORS-SWALLOWED-01 | LOW | Search | Text arm failures silently fall back to vector-only with no caller signal |
| ENTITY-ENRICH-N1-01 | MEDIUM-PERF | Entity | searchEntities() relationship fetch is N+1 serial loop |
| ENTITY-WORKER-NO-ANCHOR-01 | HIGH-SECURITY | Entity | worker.ts Step 1 bare MATCH without User anchor violates Spec 09 |
| ENTITY-INVALIDATE-SEQUENTIAL-01 | LOW-PERF | Entity | invalidateMemoriesByDescription() deleteMemory in for-loop |
| ENTITY-NORM-MISMATCH-01 | HIGH | Entity | Two normalizeName functions produce different keys â€” split-brain namespace |
| MCP-SUPERSEDE-TAG-REDUNDANT-01 | LOW | MCP | Dead-code redundant SET m.tags after supersedeMemory |
| MCP-CLASSIFY-GAP-01 | LOW-UX | MCP | COMMAND_PATTERNS missing 'wipe', 'stop knowing', 'forget about' |
| MCP-SEARCH-ENTITY-COST-01 | MEDIUM-PERF | MCP | Entity enrichment always on (5 DB trips) unless include_entities=false |
| MCP-ADD-CATEGORY-RACE-01 | LOW | MCP | Concurrent category MERGE + LLM auto-categorizer can produce case variants |
| CLUSTER-ISOLATION-01 | HIGH-SECURITY | Clusters | community_detection.get() runs cross-user Louvain |
| CLUSTER-MISSING-MEMORY-ANCHOR-01 | MEDIUM | Clusters | WHERE node = m guard insufficient; Louvain community IDs span all users |
| CONFIG-SAVE-SEQUENTIAL-01 | LOW-PERF | Config | saveConfigToDb() sequential runWrite per key |
| CONFIG-NO-TTL-CACHE-01 | MEDIUM-PERF | Config | getDedupConfig/getContextWindowConfig uncached; called per addMemory |
| DEDUP-CACHE-UNBOUNDED-01 | RESOLVED | Dedup | Cache IS LRU-limited to 1000 entries â€” confirmed not an issue |
| DEDUP-SINGLE-CANDIDATE-01 | MEDIUM | Dedup | Only top cosine candidate verified; #2 SUPERSEDE candidate never tried |
| DEDUP-VERIFY-PROMPT-STALE-01 | LOW | Dedup | few-shot examples in VERIFY_PROMPT not regenerated on provider change |
| API-FILTER-FULLSCAN-01 | MEDIUM-PERF | API | filter route uses CONTAINS scan instead of hybridSearch |
| API-FILTER-DOUBLE-QUERY-01 | LOW-PERF | API | filter route fires 2 parallel identical-WHERE traversals |
| API-BACKUP-NO-STREAM-01 | MEDIUM | API | backup/export may load all memories into RAM (needs verification) |
| API-APPS-ISOLATION-01 | HIGH-SECURITY | API | apps/[appId] route may lack User anchor (needs verification) |
| FRONTEND-NO-OPTIMISTIC-UPDATE-01 | MEDIUM-UX | Frontend | deleteMemories dispatches UI update before API confirms |
| FRONTEND-STALE-USER-ID-01 | MEDIUM | Frontend | mutation functions not wrapped in useCallback â€” stale userId closure risk |
| FRONTEND-SORT-PARAMS-IGNORED-01 | LOW | Frontend | sort_column/sort_direction sent to API but not implemented server-side |
| FRONTEND-CATEGORIES-CAST-01 | MEDIUM | Frontend | categories cast as Category[] but API returns string[] â€” runtime risk |

### Carryover from Prior Sessions (Confirmed Still Unfixed)
- CLUSTER-ISOLATION-01, ENTITY-WORKER-NO-ANCHOR-01, CONFIG-SAVE-SEQUENTIAL-01, ENTITY-ENRICH-N1-01, ENTITY-INVALIDATE-SEQUENTIAL-01, API-FILTER-FULLSCAN-01, SEARCH-HYDRATE-INVALIDAT-01, SEARCH-PAGINATION-01, MCP-CLASSIFY-GAP-01, MCP-SUPERSEDE-TAG-REDUNDANT-01

### Test Baseline (unchanged â€” read-only audit)
- **43 suites / 388 tests â€” ALL PASS**

---

## Session 8 â€” Compact Response + search_memory Recovery Test (2026-02-28)

### Objective
Two items from the Session 7 MCP evaluation report:
1. **Item 2**: Reduce `add_memories` tool output to save tokens (response was ~45% of context window)
2. **Item 5**: Stress-test `search_memory` mid-session for context recovery

### Item 2 â€” Compact `add_memories` Response

**Problem:** `add_memories` echoed full memory text in every result item back to the caller. For batch writes of 4 items with 200+ char memories, the response consumed significant context tokens. Callers need batch-item correlation but not the full text echo.

**Fix in `lib/mcp/server.ts`:**
- Added `summary` stats header to response: `{ stored, superseded, skipped, errored, invalidated, deleted_entities, total }`
- Truncated echoed `memory` field to 80 chars with `â€¦` suffix in `compactResults`
- Response shape: `{ summary: {...}, results: compactResults }` instead of `{ results }`

**Test update in `tests/unit/mcp/tools.test.ts`:**
- MCP_ADD_01 now asserts `parsed.summary` matches expected counts

### Item 5 â€” search_memory Mid-Session Context Recovery

Tested 5 query patterns against the 37 stored audit memories from Session 7:

| # | Query Pattern | Results | Recall Quality |
|---|-------------|---------|----------------|
| 1 | `"security findings cross-user namespace isolation"` | 5 hits, 0.86â€“0.97 | All 3 security findings recovered (CLUSTER-ISOLATION-01, ENTITY-WORKER-NO-ANCHOR-01, API-APPS-ISOLATION-01) |
| 2 | `"unfixed carryover findings from prior audit sessions"` | 10 hits, 0.82â€“0.94 | Findings from all layers â€” MCP, entity, search, frontend, dedup, config |
| 3 | `"HIGH severity bugs that need immediate fix"` | 10 hits, 0.83â€“0.96 | Pure semantic match (no "HIGH" literal in memory text) â€” correct action items ranked top |
| 4 | `"write pipeline atomicity problems"` | 5 hits, 0.88â€“0.99 | WRITE-ATOMIC-01 at 0.99 (rank 1 on both arms) |
| 5 | browse (no query) | total: 37 | Full inventory confirmed, tags + categories intact |

**Key conclusions:**
- **Semantic recall is strong**: Queries with zero keyword overlap still return correct results via vector similarity
- **RRF fusion working correctly**: Dual-arm hits (text + vector) get highest relevance scores
- **Context recovery viable**: An agent that lost context could reconstruct audit state from 3â€“4 targeted queries
- **Browse confirms inventory**: 37/37 memories intact with metadata

### Verification
- `tsc --noEmit`: pre-existing errors only
- `jest --runInBand`: **43 suites / 388 tests â€” ALL PASS**

---

## Session 9 â€” Agentic Architect Audit (MCP LTM, Project-Scoped Tags)

### Objective
Full read-only codebase audit using MemForge MCP as long-term memory, with project-scoped tags (`mem0ai/mem0`, `audit-session-9`). Focus on testing MCP tool scenarios end-to-end and identifying new + carryover findings across all code layers.

### MCP Tool Usage Statistics

| # | Tool | Mode | Query/Content | Purpose | Result |
|---|------|------|---------------|---------|--------|
| 1 | search_memory | browse (tag: mem0ai/mem0) | â€” | Cold-start: project-tagged count | 0 results (fresh project tag) |
| 2 | search_memory | browse (no tag, limit:3) | â€” | Total memory inventory | 41 total memories |
| 3 | search_memory | search | "unfixed carryover findings HIGH severity" | Recover prior session findings | 10 hits, 8 distinct carryovers |
| 4 | add_memories | batch (4) | Layer 1-2 findings | Store DB + Write findings | 4 ADD, 0 errors |
| 5 | add_memories | batch (4) | Layer 3-5 findings | Store API + Frontend findings | 4 ADD, 0 errors |
| 6 | search_memory | search (tag: audit-session-9) | "write pipeline archive invalidAt..." | Mid-audit recovery test | 8/8 recall (100%) |
| 7 | search_memory | search (tag: mem0ai/mem0) | "security vulnerabilities cross-user..." | Cross-session tag-scoped test | 3/12 returned (recall gap) |
| 8 | search_memory | search (tag: mem0ai/mem0) | "cluster community detection Louvain..." | Targeted security query | 1/12 returned (low confidence) |
| 9 | search_memory | search (no tag) | "cluster community detection Louvain global..." | Unfiltered cross-session test | 3 hits, 0.92â€“0.93 relevance |
| 10 | add_memories | batch (4) | Layer 5 + carryover confirmations | Store config + frontend findings | 3 ADD, 1 SUPERSEDE |
| 11 | search_memory | browse (tag: mem0ai/mem0) | â€” | Final inventory verification | 12/12 findings confirmed |
| **Totals** | **3 add / 8 search** | | **12 items sent** | | **11 stored, 1 superseded** |

### Findings Stored (12 total)

| ID | Severity | Layer | Status |
|----|----------|-------|--------|
| WRITE-ARCHIVE-NO-INVALIDAT-01 | MEDIUM | Write | NEW |
| WRITE-ADDMEMORY-2RTT-01 | LOW-PERF | Write | NEW |
| DB-VECTORFLAG-HMR-01 | LOW | DB | NEW |
| MCP-SUPERSEDE-TAG-DEAD-CODE-CONFIRMED | LOW | MCP | Carryover confirmed |
| API-DELETE-NO-HISTORY-01 | MEDIUM | API | NEW |
| MCP-SEARCH-NO-TAGS-RESPONSE-01 | LOW | MCP | NEW |
| CLUSTER-ISOLATION-01-CONFIRMED | HIGH-SEC | Clusters | Carryover confirmed |
| FRONTEND-ARCHIVE-DOUBLE-DISPATCH | LOW-UX | Frontend | NEW |
| CONFIG-NO-TTL-CACHE-01-CONFIRMED | MEDIUM-PERF | Config | Carryover (SUPERSEDED) |
| FRONTEND-STALE-CLOSURE-CONFIRMED | MEDIUM | Frontend | Carryover confirmed |
| ENTITY-RESOLVE-USER-MERGE-REDUNDANT-01 | LOW-PERF | Entity | NEW |
| API-FILTER-DOUBLE-QUERY-CONFIRMED | LOW-PERF | API | Carryover confirmed |

### MCP Tool Scenario Analysis

**Scenario 1: Cold-Start Inventory (browse)** â€” 2 calls
- `browse(tag: "mem0ai/mem0")` confirmed 0 project-scoped memories (fresh tag namespace)
- `browse(limit: 3)` confirmed 41 total memories in store from prior sessions
- **Verdict**: Essential for understanding what's already stored before writing

**Scenario 2: Cross-Session Find Recovery (search)** â€” 1 call
- Query "unfixed carryover findings HIGH severity" returned 10 results, 8 known carryover findings recovered
- Relevance scores 0.82â€“0.97, dual-arm (BM25+vector) hits scored highest
- **Verdict**: Strong. Agent can resume audit context from prior sessions without scrolling

**Scenario 3: Batched Write (add_memories)** â€” 3 calls, 12 items
- 4 items per call, zero errors, 11 ADDs + 1 SUPERSEDE
- SUPERSEDE correctly consolidated CONFIG-NO-TTL-CACHE-01 when the updated version was more detailed
- **Verdict**: Batch size of 4 is optimal â€” balances throughput with dedup quality

**Scenario 4: Mid-Audit Tag-Scoped Recovery (search + tag)** â€” 1 call
- `search_memory(query, tag: "audit-session-9")` returned all 8 session-9 findings
- 100% recall, relevance scores 0.46â€“0.93
- **Verdict**: Tag filtering + semantic search is the primary recovery mechanism

**Scenario 5: Cross-Project Tag Recovery (search + tag: mem0ai/mem0)** â€” 2 calls
- First query ("security vulnerabilities cross-user"): returned 3/12, CLUSTER finding absent
- Second query ("cluster community detection"): returned 1/12 with `confident: false`
- **Verdict**: Tag + search has a recall gap. The 3Ã— topK pre-filter (MCP-FILTER-01) may be too small for combined tag+semantic filtering. Browse + tag gives 100% recall.

**Scenario 6: Unfiltered Cross-Session Search** â€” 1 call
- "cluster community detection Louvain global multi-user" found 3 results at 0.92+ relevance
- Prior session's finding returned perfectly without any tag filter
- **Verdict**: When recall matters more than precision, drop the tag filter

**Scenario 7: SUPERSEDE via Dedup** â€” 1 organic event
- CONFIG-NO-TTL-CACHE-01 from session 7 was superseded by the session 9 version
- Correct behavior â€” same finding, more detailed description
- **Verdict**: Dedup works as designed for iterative knowledge refinement

**Scenario 8: Full Inventory Verification (browse + tag)** â€” 1 call
- `browse(tag: "mem0ai/mem0")` returned all 12 findings with correct tags and metadata
- **Verdict**: Ground truth is always accessible via browse when search has gaps

### What Worked Well
1. **Tag-scoped browse = perfect recall** â€” `tag: "mem0ai/mem0"` browse returned 12/12 findings
2. **SUPERSEDE consolidation** â€” Dedup correctly merged overlapping findings across sessions
3. **Dual-arm RRF ranking** â€” Findings with both BM25 text_rank + vector_rank scored highest
4. **Batch writes** â€” Zero errors across 3 calls Ã— 4 items
5. **Cross-session recovery** â€” Prior session findings at 0.92+ relevance without tag filter

### What Can Be Improved
1. **Search + tag post-filter recall gap** â€” 3Ã— topK multiplier insufficient when combining tag filter with semantic search. CLUSTER-ISOLATION-01 was absent from tag-filtered search despite being correctly tagged. Recommendation: increase multiplier to 5Ã— or 10Ã— when tag filter is active, or apply tag filter inside the Cypher search arms rather than post-retrieval.
2. **Tags missing from search results** â€” MCP-SEARCH-NO-TAGS-RESPONSE-01 found during this audit. Search mode results don't include `tags` field â€” agents can't see project/session tags in search results.
3. **Confidence flag false-negative** â€” `confident: false` on a valid but vector-only result (cluster finding). The heuristic requires BM25 hit OR maxScore > 0.02 â€” but valid semantic matches can score below 0.02 RRF when text arm returns nothing.
4. **External MCP still uses verbose response format** â€” The compact response format (Session 8) is only in local server.ts. External service returns full `results[]` array with memory text echo.
5. **Category enrichment inconsistency** â€” Findings stored with explicit `categories: ["Architecture", "Database"]` also received LLM auto-assigned categories ("Work", "Technology"). Expected but makes deterministic filtering harder.
---

## Session 10 â€" MCP Improvements + MemForge Rename (2026-06-01)

### Phase 1: Fix Compact Response
Dev server restart (stale SSE connection) â€" compact `add_memories` format verified working: `{"ids":[...],"stored":N}`.

### Phase 2: 3 MCP Improvements from Session 9 Audit
1. **topK multiplier**: tag filter â†' 10Ã—, category/date filter â†' 5Ã—, no filter â†' 1Ã—
2. **Tags in search results**: added `tags: r.tags ?? []` to search response
3. **Confidence heuristic**: RRF threshold 0.02 â†' 0.012 (above 1/(K+1) where K=60 â‰ˆ 0.016 was too high for vector-only results)

### Phase 3: Project Rename â€" openmemory/mem0 â†' MemForge

**Scope:** Every reference to `openmemory`, `OpenMemory`, `OPENMEMORY_`, `mem0` (project name, not GitHub org), `Mem0` renamed to appropriate MemForge variant.

**Naming convention applied:**
- Brand text (UI titles, docs, comments): `MemForge` (PascalCase)
- Database values, app names, config keys: `memforge` (lowercase)
- Environment variables: `MEMFORGE_` prefix (UPPER_SNAKE_CASE)
- Docker service/volume/network names: `memforge` (lowercase, Docker convention)
- URL paths, npm scopes: `memforge` (lowercase)
- TypeScript schema exports: `MemForgeConfigSchema`, `MemforgeExtConfigSchema` (PascalCase)

**Directory renames (3):**
- `lib/mem0/` â†' `lib/memforge/`
- `app/api/v1/config/openmemory/` â†' `app/api/v1/config/memforge/`
- `app/api/v1/config/mem0/*` merged into `app/api/v1/config/memforge/`

**Bulk content replacement (Phase 2a â€" OpenMemory patterns):**
`OPENMEMORY_` â†' `MEMFORGE_`, `@/lib/mem0/` â†' `@/lib/memforge/`, `OpenMemory` â†' `MemForge`, `openmemory-` â†' `memforge-`, `openmemory_` â†' `memforge_`

**Bulk content replacement (Phase 2b â€" mem0 patterns, 19 files):**
`mem0-mcp-server` â†' `memforge-mcp-server`, `mem0-ts/oss` â†' `memforge-ts/oss`, `/config/mem0/` â†' `/config/memforge/`, Docker image/DB/volume refs.

**Manual case fixes (config keys + DB values):**
- `lib/config/helpers.ts`: Config keys `memforge` and `memforge_ext` (lowercase for Memgraph)
- `lib/validation.ts`: `Mem0ConfigSchema` â†' `MemforgeExtConfigSchema`, config key `memforge_ext`
- `lib/mcp/server.ts`: `source_app: "memforge"` (lowercase DB value)
- Default app names: `.default("memforge")` in validation, bulk, hooks, API routes
- `source-app.tsx`: registry key `memforge` (matches DB), display name `"MemForge"`
- `Install.tsx`: URL paths `/mcp/memforge/sse/`, npm scope `@memforge/install`
- `app/api/v1/config/memforge/route.ts`: CONFIG_KEY `"memforge_config"` (was `"MEMFORGE_config"`)
- Docker compose: service/volume/network names lowercase (`memforge`, `memforge_data`, `memforge-net`)
- `tests/e2e/10-actions-config.test.ts`: API paths `/api/v1/config/memforge`
- `package.json`: name `"memforge"`, BOM stripped after Node.js write

**Not renamed (correct):**
- `.github/workflows/ci.yml`, `cd.yml`: `mem0/**` path filters reference physical git directory
- `AGENTS.md`: historical session logs left as-is (accurate history)
- `.github/instructions/openmemory.instructions.md`: filename unchanged (non-critical)

**Bug fixed during rename:**
- `lib/mcp/server.ts` L201: Node.js `replace()` wrote escaped quotes `\"memforge\"` instead of `"memforge"` â€" manually corrected.
- `package.json`: Node.js `writeFileSync` preserved UTF-8 BOM from prior PowerShell write â€" stripped 3-byte BOM prefix.

### Verification
- `tsc --noEmit`: 1 pre-existing error only (TS-001: `.next/types` MCP SSE route)
- `jest --runInBand --no-coverage`: **43 suites / 388 tests — ALL PASS**

---

## Session 11 — GraphRAG-Inspired Pipeline + CI/CD Modernization

### Phase 1: GitHub Workflows Audit & Fix

All 3 workflow files were from the original Python `mem0` OSS project — completely incompatible with the Next.js/pnpm monolith.

| File | Before | After |
|------|--------|-------|
| `.github/workflows/ci.yml` | Python: pip/hatch/ruff | 4 parallel jobs: typecheck, lint, test, build (pnpm 9, node 18) |
| `.github/workflows/cd.yml` | PyPI publishing | Docker build + push to GHCR (Buildx + GHA cache, semver tags) |
| `.github/workflows/copilot-setup-steps.yml` | npm, `npx run build` | pnpm setup, `pnpm install --frozen-lockfile`, `pnpm build` |

### Phase 2: GraphRAG Deep Analysis

Researched Microsoft GraphRAG via DeepWiki. Compared entity extraction, community detection, graph pruning, relationship extraction against MemForge's existing pipeline. Produced ranked recommendations (P0–P4).

### Phase 3: GraphRAG Implementation (6 features)

**Key design decision:** Cross-user community detection is **intentional** — shared knowledge across users/projects is a core value proposition. NOT a security bug.

#### P0 — Wire Relationship Extraction into Write Pipeline
- **New file: `lib/entities/relate.ts`** (~55 lines)
  - `linkEntities(sourceId, targetId, relType, description)` — MERGE with ON CREATE/ON MATCH
  - Keeps longer description on conflict; type stored as property (not edge label)
  - relType normalized: uppercase + spaces→underscores
- **Worker Step 7**: After entity resolution, relationships from combined extraction are resolved to entity IDs and linked via `linkEntities()`. Dangling references (entity not in extraction) silently skipped.

#### P1 — Entity Description Summarization
- **New file: `lib/entities/summarize-description.ts`** (~83 lines)
  - `summarizeEntityDescription(entityId, entityName, incomingDescription)` — LLM consolidation
  - Skip conditions: empty incoming, no existing, identical descriptions
  - Uses `ENTITY_DESCRIPTION_SUMMARIZE_PROMPT` with `{entityName}`, `{descriptionA}`, `{descriptionB}` placeholders
- **Worker Step 8**: Fire-and-forget for Tier 1 hits (entities that already existed before this memory). `.catch()` prevents pipeline disruption.

#### P2 — Gleaning (Multi-Pass Extraction)
- **Rewritten: `lib/entities/extract.ts`**
  - `extractEntitiesAndRelationships(content)` — single LLM call returns `{ entities, relationships }`
  - Gleaning loop: `MEMFORGE_MAX_GLEANINGS` env var (default 1, cap 3), uses `GLEANING_PROMPT`
  - Deduplicates gleaned entities by name, relationships by `(source, target, type)` triple
  - Backward-compatible: `extractEntitiesFromMemory()` wrapper still exported

#### P2 — Hierarchical Community Detection
- **Rewritten: `lib/clusters/build.ts`**
  - `rebuildClusters(userId)` — cross-user global graph (intentional), Louvain via MAGE
  - L0 + L1 hierarchy: groups >= `SUBCOMMUNITY_THRESHOLD` (8) get L1 subcommunities
  - `[:SUBCOMMUNITY_OF]` edges connect L1→L0 community nodes
  - `CommunityNode` interface exported with `level`, `parentId` properties
  - Constants: `MIN_COMMUNITY_SIZE=2`, `SUBCOMMUNITY_THRESHOLD=8`, `MAX_LEVELS=2`

#### P4 — Combined Extraction Prompt
- **Modified: `lib/entities/prompts.ts`**
  - `ENTITY_EXTRACTION_PROMPT` now requests both `entities[]` and `relationships[]` in JSON
  - Added `GLEANING_PROMPT` with `{previousEntities}` placeholder
  - Added `ENTITY_DESCRIPTION_SUMMARIZE_PROMPT`

### Files Created (3)
| File | Lines | Purpose |
|------|-------|---------|
| `lib/entities/relate.ts` | 55 | [:RELATED_TO] edge MERGE between entities |
| `lib/entities/summarize-description.ts` | 83 | LLM entity description consolidation |
| `tests/unit/entities/relate.test.ts` | 55 | 3 tests: RELATE_01–03 |
| `tests/unit/entities/summarize-description.test.ts` | 95 | 5 tests: SUM_01–05 |

### Files Rewritten (delete + recreate due to encoding issues)
| File | Purpose |
|------|---------|
| `lib/entities/extract.ts` | Combined extraction + gleaning |
| `lib/entities/worker.ts` | 9-step pipeline orchestrator |
| `lib/clusters/build.ts` | Hierarchical community detection |
| `tests/unit/entities/worker.test.ts` | 9 tests: WORKER_01–09 |

### Files Modified
| File | Change |
|------|--------|
| `lib/entities/prompts.ts` | Combined extraction prompt, gleaning prompt, description summarize prompt |
| `.github/workflows/ci.yml` | Full rewrite for Next.js/pnpm |
| `.github/workflows/cd.yml` | Full rewrite for Docker/GHCR |
| `.github/workflows/copilot-setup-steps.yml` | npm→pnpm fix |

### Test Results
| Test File | Count | Status |
|-----------|-------|--------|
| `worker.test.ts` | 9 | PASS (WORKER_01–09) |
| `relate.test.ts` | 3 | PASS (RELATE_01–03) |
| `summarize-description.test.ts` | 5 | PASS (SUM_01–05) |
| `extract.test.ts` | 4 | PASS (pre-existing + new) |
| `build.test.ts` | 2 | PASS |
| **Full suite** | **398 tests, 45 suites** | **ALL PASS** |

### Verification
- `tsc --noEmit`: 1 pre-existing error only (TS-001)
- `jest --runInBand --no-coverage`: **45 suites / 398 tests — 0 failures**

---

## Session 12 — Pre-existing Error Resolution

### Objective
Fix all documented pre-existing errors (TS-001, TEST-001, E2E-001).

### TS-001 — `.next/types` TS2344 error (activeTransports re-export)
**Root cause:** `app/mcp/[clientName]/sse/[userId]/route.ts` had `export { activeTransports }` — a `Map<string, NextSSETransport>` re-export. Next.js App Router type checker (`checkFields<Diff<...>>()`) requires route modules only export valid route handlers (`GET`, `POST`, etc.) and config (`dynamic`, `revalidate`, etc.). A `Map` export violates the index signature constraint `{ [x: string]: never }`.

**Fix:** Removed `export { activeTransports };` from the route file. All consumers already import from `@/lib/mcp/registry` directly — the re-export was dead code.

### TEST-001 — resolve.test.ts "requires live Memgraph"
**Status:** Already fixed in prior session. All 19 tests pass with full mocking — semantic dedup tests (RESOLVE_13, 14, 15) mock `embed()`, `getLLMClient()`, `runRead`, and `runWrite`. No live Memgraph needed.

### E2E-001 — e2e tests require running server
**Status:** Already handled (Session 5). `jest.config.ts` `testMatch` excludes e2e from `pnpm test`. E2E runs via `pnpm test:e2e` only.

### Additional fix: worker.ts implicit `any`
Added `err: unknown` type annotation to `.catch()` callback in `summarizeEntityDescription` fire-and-forget call.

### Verification
- `tsc --noEmit`: **0 errors** (first time ever — TS-001 resolved)
- `jest --runInBand --no-coverage`: **45 suites / 398 tests — 0 failures**

---

## Session 13 — Graphiti-Inspired Pipeline Enhancements (P0–P3)

### Objective
Implement 4 Graphiti-inspired enhancements to the entity extraction and relationship pipeline. Each adds measurable value to the knowledge graph quality.

### P0 — Edge Temporal Contradiction Detection (HIGH VALUE)
- **File:** `lib/entities/relate.ts` (rewritten ~160 lines)
- Before: MERGE-based `linkEntities()` that silently overwrote descriptions (kept longer)
- After: Bi-temporal edges with `validAt`/`invalidAt` + LLM contradiction classification
- Pipeline:
  1. Check for existing live edge (`WHERE r.invalidAt IS NULL`)
  2. P2 fast-path: identical normalized description → skip entirely
  3. Both descriptions non-empty → LLM classifies: `SAME | UPDATE | CONTRADICTION`
  4. `SAME` → no-op; `UPDATE`/`CONTRADICTION` → invalidate old edge, create new one
  5. No existing edge → create with `validAt` timestamp
- New export: `classifyEdgeContradiction()` — fail-open to `UPDATE` on LLM errors
- **Prompt:** `EDGE_CONTRADICTION_PROMPT` added to `lib/entities/prompts.ts`

### P1 — Entity Summary Generation (MEDIUM VALUE)
- **New file:** `lib/entities/summarize-entity.ts` (~130 lines)
- `generateEntitySummary(entityId)` — fetches all connected memories ([:MENTIONS]) and relationships ([:RELATED_TO]), generates comprehensive 2-4 sentence profile via LLM
- `getEntityMentionCount(entityId)` — threshold check: only generates summary when entity has ≥ `SUMMARY_THRESHOLD` (3) connected memories
- Writes to `e.summary` + `e.summaryUpdatedAt` on the Entity node
- **Prompt:** `ENTITY_SUMMARY_PROMPT` added to `lib/entities/prompts.ts`
- **Worker integration:** Step 9 in `worker.ts` — for Tier 1 hits (pre-existing entities), checks mention count and triggers summary generation. Best-effort with try/catch.

### P2 — Fast-Path Edge Dedup (LOW-MEDIUM VALUE)
- **Integrated into P0's `linkEntities()` rewrite**
- Before the full MERGE/contradiction check: normalize descriptions (lowercase, collapse whitespace, trim)
- If `normalizeDesc(oldDesc) === normalizeDesc(newDesc)` → skip entirely (no DB write, no LLM call)
- Saves 1 `runWrite` + potentially 1 LLM call per duplicate edge

### P3 — Previous Memory Context for Extraction (LOW-MEDIUM VALUE)
- **File:** `lib/entities/extract.ts` — added `ExtractionOptions.previousMemories?: string[]`
- `buildPreviousContextBlock()` — formats up to 3 recent memories with explicit instruction: "DO NOT extract entities from these, only use them to resolve pronouns and references"
- Injected as suffix to the LLM user message in pass 1 extraction
- **Worker integration:** Step 4a in `worker.ts` — fetches last 3 user memories (`WHERE m.id <> $memoryId AND m.invalidAt IS NULL, ORDER BY createdAt DESC, LIMIT 3`) before extraction
- **Backward-compatible:** `extractEntitiesAndRelationships(content)` still works without options; `extractEntitiesFromMemory(content, options?)` also accepts optional context

### Files Created (2)
| File | Lines | Purpose |
|------|-------|---------|
| `lib/entities/summarize-entity.ts` | 130 | Entity profile summary generation |
| `tests/unit/entities/summarize-entity.test.ts` | 135 | 7 tests: ESUM_01–06 |

### Files Modified (5)
| File | Change |
|------|--------|
| `lib/entities/relate.ts` | Full rewrite: temporal edges + fast-path dedup + LLM contradiction |
| `lib/entities/extract.ts` | Added `ExtractionOptions`, `buildPreviousContextBlock()`, context injection |
| `lib/entities/worker.ts` | Step 4a (P3 context fetch), Step 7 (entity names to linkEntities), Step 9 (P1 summary) |
| `lib/entities/prompts.ts` | Added `EDGE_CONTRADICTION_PROMPT`, `ENTITY_SUMMARY_PROMPT` |
| `tests/unit/entities/relate.test.ts` | Rewritten: 11 tests (RELATE_01–11) covering temporal + fast-path + contradiction |
| `tests/unit/entities/worker.test.ts` | Updated all tests for P3 runRead, added WORKER_10 (P3), WORKER_11 (P1) |
| `tests/unit/entities/extract.test.ts` | Added EXTRACT_05–07 (P3 context injection, cap at 3) |

### Bugs Fixed During Test Writing
- **Orphaned `mockResolvedValueOnce` leakage** (WORKER_04, WORKER_10): Tests that return `entities: []` don't trigger Tier 1 batch read, so the 4th Once value leaked into the next test. Fix: only queue the exact number of Once values that will be consumed.
- **`SUMMARY_THRESHOLD` auto-mock**: `jest.mock("@/lib/entities/summarize-entity")` auto-replaces numeric exports with `0`, not `undefined`. Used `require()` to get mocked module reference instead of ESM import.

### Test Results
- **`tsc --noEmit`: 0 errors**
- **`jest --runInBand --no-coverage`: 46 suites / 418 tests — 0 failures** (up from 45/398)

---

## Session 14 — Agentic Architect Audit (MCP LTM Stress Test)

### Objective
Full read-only codebase audit across 8 layers (DB, write pipeline, search, entity, MCP server, API routes, frontend, config/infra) using MemForge MCP as long-term memory. Designed to test MCP tools in a realistic agentic workflow where findings exceed a single LLM context window.

### MCP Tool Usage Statistics

| # | Tool | Mode | Query/Content | Purpose | Result |
|---|------|------|---------------|---------|--------|
| 1 | search_memory | browse (tag: audit-session-14) | — | Cold-start: session-tagged count | 0 results (fresh tag) |
| 2 | search_memory | browse (no tag, limit:3) | — | Total inventory | 59 total memories |
| 3 | add_memories | batch (4) | DB + Write findings | Store Layer 1-2 findings | 3 ADD, 1 SUPERSEDE |
| 4 | add_memories | batch (4) | Search + Entity findings | Store Layer 3-4 findings | 4 ADD |
| 5 | add_memories | batch (4) | Security + API findings | Store Layer 6 findings | 4 ADD |
| 6 | add_memories | batch (4) | Frontend + Config findings | Store Layer 7-8 findings | 3 ADD, 1 SUPERSEDE |
| 7 | add_memories | batch (4) | MCP + Entity layer findings | Store Layer 5 findings | 4 ADD |
| 8 | add_memories | batch (4) | Additional + refactoring findings | Store cross-cutting findings | 2 ADD, 2 SUPERSEDE |
| 9 | search_memory | browse (tag: audit-session-14) | — | Full inventory check | 24 results (100% recall) |
| 10 | search_memory | search + tag | "security vulnerabilities cross-user..." | Recovery Test 1: security | 10/24, both HIGH-SEC in top 3 |
| 11 | search_memory | search + tag | "performance bottlenecks N+1 queries..." | Recovery Test 2: perf | 8/24, N+1 ranked #1-#2 |
| 12 | search_memory | search (no tag) | "high severity bugs that need immediate fix" | Recovery Test 3: cross-session | 5 results across sessions 7,8,9,14 |
| 13 | search_memory | search + tag | "write pipeline atomicity supersedeMemory..." | Recovery Test 4: domain-specific | 7/24, ranked #1 (0.92) |
| 14 | search_memory | browse (tag: mem0ai/mem0) | — | Recovery Test 5: project-scoped | 35 total across sessions |
| **Totals** | **6 add / 8 search** | | **24 items sent** | | **20 stored, 4 superseded** |

### Findings Stored (24 total, 20 new + 4 superseded prior findings)

| ID | Severity | Layer | Status |
|----|----------|-------|--------|
| DB-CLOSE-NO-SIGTERM-01 | LOW | DB | NEW |
| DB-VECTOR-FLAG-HMR-01 | LOW | DB | NEW |
| WRITE-SUPERSEDE-NOT-ATOMIC-01 | MEDIUM | Write | SUPERSEDED prior |
| WRITE-ARCHIVE-NO-INVALIDAT-01 | MEDIUM | Write | NEW |
| SEARCH-HYDRATE-NO-BITEMPORAL-01 | MEDIUM | Search | NEW |
| SEARCH-PAGINATION-LOSSY-01 | MEDIUM | Search | NEW |
| ENTITY-ENRICH-N-PLUS-1-01 | MEDIUM-PERF | Entity | NEW |
| ENTITY-WORKER-STEP1-NO-ANCHOR-01 | LOW-SECURITY | Entity | NEW |
| API-APPS-NO-USER-ANCHOR-01 | HIGH-SECURITY | API | NEW |
| API-APPS-PUT-NO-AUTH-01 | HIGH-SECURITY | API | NEW |
| API-BACKUP-OOM-01 | MEDIUM | API | NEW |
| API-FILTER-FULLSCAN-01 | MEDIUM-PERF | API | NEW |
| FRONTEND-STALE-CLOSURE-01 | MEDIUM | Frontend | NEW |
| FRONTEND-OPTIMISTIC-DELETE-01 | MEDIUM-UX | Frontend | NEW |
| CONFIG-NO-TTL-CACHE-01 | MEDIUM-PERF | Config | SUPERSEDED prior |
| CLUSTER-SEQUENTIAL-WRITES-01 | LOW-PERF | Clusters | NEW |
| MCP-SUPERSEDE-TAG-DEAD-CODE-01 | LOW | MCP | NEW |
| ENTITY-SUMMARIZE-NO-USER-ANCHOR-01 | LOW | Entity | NEW |
| EXTRACT-NO-CODE-FENCE-STRIP-01 | LOW | Entity | NEW |
| MIDDLEWARE-NOT-ADOPTED-01 | LOW | Infra | NEW |
| RESOLVE-REDUNDANT-USER-MERGE-01 | LOW-PERF | Entity | SUPERSEDED prior |
| WRITE-SUPERSEDE-NO-ENTITY-EXTRACT-01 | HIGH | Write | SUPERSEDED prior |
| FILTER-DOUBLE-QUERY-01 | LOW-PERF | API | NEW |
| BACKUP-EXPORT-EMBEDDING-01 | LOW | API | NEW |

### MCP Tool Scenario Evaluation

| Scenario | Calls | Usefulness | Verdict |
|----------|-------|------------|---------|
| Cold-start inventory (browse) | 2 | 10/10 | ESSENTIAL — prevents duplicate work |
| Batched write (add_memories) | 6 | 9/10 | RELIABLE — 0 errors, dedup works |
| Tag-scoped browse (recall) | 1 | 10/10 | GROUND TRUTH — 24/24 recall |
| Semantic search + tag (recovery) | 3 | 9/10 | STRONG — targeted findings at high relevance |
| Cross-session query (no tag) | 1 | 10/10 | KEY VALUE — multi-session accumulation |
| Project-scoped inventory | 1 | 8/10 | USEFUL — per-repo knowledge management |

### What Worked Well
1. **Dedup across sessions** — 4 findings from prior sessions correctly superseded
2. **Tag-scoped browse = perfect recall** — 24/24 findings returned
3. **Semantic search ranking** — HIGH-SECURITY findings in top 3 for security queries
4. **Cross-session accumulation** — 35 project-scoped findings across 4 sessions
5. **Compact response format** — `{ids, stored, superseded}` saves context tokens
6. **Batch writes zero errors** — 6 × 4 items = 24 items, no failures
7. **Dual-arm RRF** — BM25 + vector hits scored highest relevance

### What Can Be Improved
1. **SUPERSEDE across sessions loses context**: cross-session dedup can consume prior session's version. Need `dedup: false` or `dedup_scope: "session"` option.
2. **Category enrichment adds noise**: LLM auto-assigns "Technology", "Work" alongside explicit "Security", "API". Need option to suppress auto-categorization when explicit categories provided.
3. **No `superseded_ids` in response**: when dedup supersedes findings, caller can't see which prior items were consumed. Add to response.
4. **Entity enrichment latency on search**: every search enriches with entities (5 DB trips). For audit recall, `include_entities: false` should be default.
5. **Browse + search mutually exclusive**: need both "all items tagged X" (completeness) AND "ranked by relevance" (precision) in one query.
6. **Low `confident` threshold for tag-filtered search**: tag post-filter removes results after RRF scoring, which can cause `confident: false` on valid vector-only results that survive the tag filter.

### Test Baseline (unchanged — read-only audit)
- **46 suites / 418 tests — ALL PASS**

---

## Session 15 — Audit Findings Implementation (P0–P2)

### Objective
Implement 7 high-priority fixes from Session 14 audit findings, with test coverage.

### Fixes Applied

| ID | Severity | File | Fix |
|----|----------|------|-----|
| API-APPS-NO-USER-ANCHOR-01 | HIGH-SECURITY | app/api/v1/apps/[appId]/route.ts | GET now requires `user_id` and anchors App lookup through `(u:User)-[:HAS_APP]->(a:App)` instead of bare `(a:App)` |
| API-APPS-PUT-NO-AUTH-01 | HIGH-SECURITY | app/api/v1/apps/[appId]/route.ts | PUT now requires `user_id` and anchors update through `(u:User)-[:HAS_APP]->(a:App)` |
| SEARCH-HYDRATE-NO-BITEMPORAL-01 | MEDIUM | lib/search/hybrid.ts | Added `WHERE m.invalidAt IS NULL` to hydration UNWIND query — defense-in-depth against invalidated memories leaking into results |
| WRITE-SUPERSEDE-NOT-ATOMIC-01 | MEDIUM | lib/memory/write.ts | Merged App attachment into the same Cypher query as invalidate+create+link — `supersedeMemory()` now uses 1 `runWrite` call (was 2) with inline `MERGE App + CREATED_BY` |
| WRITE-ARCHIVE-NO-INVALIDAT-01 | MEDIUM | lib/memory/write.ts | `archiveMemory()` now sets `m.invalidAt = $now` — archived memories correctly excluded from bi-temporal queries (`WHERE m.invalidAt IS NULL`) |
| ENTITY-ENRICH-N-PLUS-1-01 | MEDIUM-PERF | lib/mcp/entities.ts | Replaced per-entity for-loop relationship fetch with single UNWIND batch query — 1 DB round-trip instead of N |
| CONFIG-NO-TTL-CACHE-01 | MEDIUM-PERF | lib/config/helpers.ts | Added 30s TTL cache for `getConfigFromDb()` — `getDedupConfig()` and `getContextWindowConfig()` no longer hit Memgraph on every `addMemory()` call. `saveConfigToDb()` invalidates cache. Exported `invalidateConfigCache()` for tests. |

### Tests Added/Updated

| File | Change | Tests |
|------|--------|-------|
| tests/unit/routes/apps-security.test.ts | NEW | APPS_SEC_01–04: GET/PUT require user_id, anchor through User |
| tests/unit/config/config-cache.test.ts | NEW | CONFIG_TTL_01–04: TTL cache hit/miss, save invalidation, manual invalidation |
| tests/unit/mcp/entities.test.ts | UPDATED | ENTITY_SEARCH_01–07,11: relationship mocks updated for UNWIND batch; added ENTITY_SEARCH_11 (verifies single UNWIND for N entities) |
| tests/unit/memory/write.test.ts | UPDATED | WR_31: updated for 1-call supersede (was 2); Added WR_53: archiveMemory sets invalidAt |
| tests/unit/config/dedup-config.test.ts | UPDATED | Added `invalidateConfigCache()` to beforeEach for TTL cache compatibility |

### Files Modified (7 source + 5 test)

**Source:**
1. `app/api/v1/apps/[appId]/route.ts` — User anchor + user_id required
2. `lib/search/hybrid.ts` — invalidAt IS NULL in hydration
3. `lib/memory/write.ts` — atomic supersede, archive invalidAt
4. `lib/mcp/entities.ts` — UNWIND batch relationships
5. `lib/config/helpers.ts` — TTL cache + invalidation

**Tests:**
1. `tests/unit/routes/apps-security.test.ts` (new, 4 tests)
2. `tests/unit/config/config-cache.test.ts` (new, 4 tests)
3. `tests/unit/mcp/entities.test.ts` (updated, +1 new test)
4. `tests/unit/memory/write.test.ts` (updated, +1 new test)
5. `tests/unit/config/dedup-config.test.ts` (updated for cache compat)

### Verification
- `tsc --noEmit`: **0 errors**
- `jest --runInBand --no-coverage`: **48 suites / 428 tests — 0 failures** (up from 46/418)

---

## Session 16 — Claimify-Inspired Fact Extraction Quality (2026-03-01)

### Objective
Implement two high-value techniques from Microsoft Research's Claimify paper (ACL 2025) to improve extracted memory quality: self-containment (pronoun/reference resolution) and atomic fact decomposition.

### Analysis Summary
Claimify is a 4-stage claim extraction pipeline (sentence split → selection → disambiguation → decomposition) designed for fact-checking LLM outputs. After deep comparison:
- **MemForge already superior** in: knowledge graph structure, bi-temporal management, dedup pipeline, multi-pass gleaning, co-reference context injection
- **Claimify techniques adopted**: self-containment rules (resolve pronouns/temporal refs) and atomic decomposition (split compound facts)
- **Not adopted**: verifiability filter (would discard opinions/preferences — core memory types), ambiguity flagging (low ROI given entity dedup)

### Changes Made

**File: `lib/memory/extract-facts.ts`**

**User-mode prompt — 3 enhancements:**
1. **Self-Containment Rules section**: Explicit instructions to resolve all pronouns (he/she/they/it → actual names), temporal references (yesterday → concrete date), implicit references (the project → actual project name), and preserve critical context qualifiers
2. **Atomic Decomposition Rules section**: Each fact MUST contain exactly ONE piece of information; compound statements MUST be split
3. **Updated few-shot examples** (4 original + 3 new): meeting example resolves "We" and splits compound; movies split to individual facts; Google example (NEW) resolves "she" → "Sarah"; Italy example (NEW) resolves pronouns + temporal refs

**Agent-mode prompt — 3 enhancements:**
1. **Self-Containment Rules section**: Pronoun resolution + implicit reference resolution
2. **Atomic Decomposition Rules section**: Same splitting rules with agent-specific examples
3. **Updated few-shot examples**: movies split to individual; Python/JS example (NEW) splits 3 capabilities into atomic facts

### Why These Changes Matter

| Dimension | Before | After |
|-----------|--------|-------|
| Pronoun resolution | Not enforced | Resolved — "He prefers VS Code" → "John prefers VS Code" |
| Temporal references | "yesterday" stored literally | Resolved to concrete date |
| Compound facts | "Name is John and is a Software engineer" | Split into 2 atomic facts |
| Dedup accuracy | Compound facts harder to match | Atomic facts match more precisely |
| Search recall | Diluted vector on compound | Focused facts score higher |
| SUPERSEDE precision | Superseding compound affects all sub-facts | Each fact superseded independently |

### Tests Added (6 new)

| Test | Description |
|------|-------------|
| FACTS_10 | User prompt contains Self-Containment Rules section |
| FACTS_11 | User prompt contains Atomic Decomposition Rules section |
| FACTS_12 | Agent prompt contains Self-Containment Rules section |
| FACTS_13 | Agent prompt contains Atomic Decomposition Rules section |
| FACTS_14 | User few-shots demonstrate pronoun resolution (Emily, Sarah, Google) |
| FACTS_15 | User few-shots demonstrate atomic splitting (individual movies, separate name/role) |

### Verification
- `tsc --noEmit`: **0 errors**
- `jest --runInBand --no-coverage`: **48 suites / 434 tests — 0 failures** (up from 428)

---

## Session 17 — Agentic Architect Audit (MCP LTM Stress Test) (2026-03-01)

### Objective
Full read-only codebase audit across 6 layers (DB, write pipeline, search, entity, MCP/API, frontend/config) using MemForge MCP as long-term memory. Designed to test MCP tools in a realistic agentic workflow where findings exceed a single LLM context window.

### MCP Tool Usage Statistics

| # | Tool | Mode | Purpose | Result |
|---|------|------|---------|--------|
| 1-2 | search_memory | browse | Cold-start inventory | 0 session-tagged / 79 total |
| 3 | search_memory | search + tag | Prior session recovery | 11 hits, 8 carryovers |
| 4-7 | add_memories | batch (4×4) | Store findings | 14 ADD, 2 SUPERSEDE |
| 8 | search_memory | search + tag | Security recovery test | 3/3 HIGH found |
| 9 | search_memory | browse + tag | Full inventory | 16/16 (100% recall) |
| 10 | search_memory | search (no tag) | Cross-session perf | 10 hits across 4 sessions |
| 11-12 | search_memory | search + tag, browse | Domain + project scope | 49 project memories |
| **Total** | **4 add / 8 search** | | **16 items** | **14 stored, 2 superseded** |

### Findings Stored (16 total, 12 new + 2 superseded + 2 carryover confirmed)

| ID | Severity | Layer | Status |
|----|----------|-------|--------|
| PAUSE-NO-INVALIDAT-01 | MEDIUM | Write | NEW |
| MCP-SUPERSEDE-TAG-STILL-DEAD-CODE | LOW | MCP | Carryover |
| DB-CLOSE-NO-LIFECYCLE-01 | LOW | DB | NEW |
| WRITE-ADDMEM-2RTT-STILL-UNFIXED | LOW-PERF | Write | SUPERSEDED |
| MCP-ENTITY-REL-NO-TEMPORAL-01 | MEDIUM | Entity | NEW |
| EXTRACT-GLEANING-NO-CONTEXT-01 | LOW | Entity | NEW |
| TEXT-SEARCH-NO-TRYCATCH-01 | MEDIUM | Search | NEW |
| CLUSTER-REBUILD-PARTIAL-WRITE-01 | MEDIUM | Clusters | NEW |
| HOOK-APPS-UPDATE-BROKEN-01 | HIGH | Frontend | NEW |
| HOOK-APPS-ACCESSED-NO-AUTH-01 | HIGH-SECURITY | Frontend | NEW |
| MEMORIES-GET-CAT-POSTFILTER-TOTAL-01 | MEDIUM | API | NEW |
| HOOK-APPS-STALE-USERID-01 | MEDIUM | Frontend | NEW |
| CLASSIFY-NO-FENCE-STRIP-01 | LOW | MCP | NEW |
| MEMORYID-PUT-STILL-NO-ENTITY-EXTRACT-01 | HIGH | API | SUPERSEDED |
| FILTER-NO-SIZE-BOUNDS-01 | LOW | API | NEW |
| APPS-NO-TRYCATCH-01 | MEDIUM | API | NEW |

### MCP Tool Scenario Evaluation

| Scenario | Calls | Usefulness | Verdict |
|----------|-------|------------|---------|
| Cold-start inventory (browse) | 2 | 10/10 | ESSENTIAL |
| Carryover recovery (search) | 1 | 10/10 | KEY VALUE |
| Batched write (add_memories) | 4 | 9/10 | RELIABLE |
| Tag + semantic search (recovery) | 2 | 9/10 | STRONG |
| Full session inventory (browse) | 1 | 10/10 | GROUND TRUTH |
| Cross-session perf query | 1 | 10/10 | EXCEPTIONAL |
| Project-scoped inventory | 1 | 8/10 | USEFUL |

### What Worked Well
1. Cross-session dedup — 2 findings correctly superseded across sessions
2. Tag-scoped browse = 100% recall (16/16)
3. Dual-arm RRF ranking — cross-session findings at 0.91 relevance
4. Zero write errors (4×4 = 16 items)
5. Compact response format saves tokens
6. Semantic search finds non-keyword matches

### What Can Be Improved
1. Tag + search should warn when result set << tagged total
2. SUPERSEDE loses prior session origin tag
3. No total_matching count in search response
4. Category auto-enrichment adds noise ("Technology", "Work" on every finding)
5. No updated_at in search mode results
6. No intra-batch dedup for same-call items

### Test Baseline (unchanged — read-only audit)
- **48 suites / 434 tests — ALL PASS**

---

## Session 18 — MCP Improvements Implementation (6 Audit Findings)

### Objective
Implement 6 MCP improvement opportunities identified in the Session 17 agentic audit report. All improvements add test coverage.

### Improvements Implemented

| # | ID | File(s) | Description |
|---|-----|---------|-------------|
| 1 | MCP-UPDATED-AT-01 | hybrid.ts, server.ts | `updated_at` field added to search mode results. `HybridSearchResult` interface gains `updatedAt`; hydration Cypher returns `m.updatedAt`; server maps with fallback to `createdAt` |
| 2 | MCP-TOTAL-01 | server.ts | `total_matching` count in search response — pre-limit match count so agents know when more results exist beyond the cap |
| 3 | MCP-TAG-RECALL-01 | server.ts | Tag filter recall warning — when tag post-filter drops >70% of results, response includes `tag_filter_warning` recommending browse mode |
| 4 | MCP-CAT-SUPPRESS | write.ts, server.ts | `suppress_auto_categories` boolean parameter on `add_memories` — skips LLM auto-categorization fire-and-forget when callers provide explicit categories |
| 5 | SUPERSEDE-PROVENANCE | write.ts, server.ts | SUPERSEDE provenance tags — `supersedeMemory()` now merges old memory's tags with new explicit tags (deduplicated) so session origin is preserved. Removed dead-code `SET m.tags` runWrite from server.ts (MCP-SUPERSEDE-TAG-01) |
| 6 | MCP-BATCH-DEDUP | server.ts | Intra-batch dedup — normalized text tracker catches exact duplicate content within the same `add_memories` batch call (case/whitespace-insensitive) before hitting the DB dedup pipeline |

### Tests Added (20 new)

| Test ID | File | Improvement |
|---------|------|-------------|
| MCP_UPDATED_AT_01 | tools.test.ts | #1: search results include `updated_at` |
| MCP_UPDATED_AT_02 | tools.test.ts | #1: fallback to `createdAt` when `updatedAt` missing |
| MCP_TOTAL_01 | tools.test.ts | #2: `total_matching` > returned count when limit caps |
| MCP_TOTAL_02 | tools.test.ts | #2: `total_matching` reflects tag post-filter count |
| MCP_TAG_WARN_01 | tools.test.ts | #3: warning emitted when >70% dropped by tag filter |
| MCP_TAG_WARN_02 | tools.test.ts | #3: no warning when retention >30% |
| MCP_TAG_WARN_03 | tools.test.ts | #3: no warning without tag filter |
| MCP_CAT_SUPPRESS_01 | tools.test.ts | #4: `suppress_auto_categories=true` passes through |
| MCP_CAT_SUPPRESS_02 | tools.test.ts | #4: default passes `false` |
| WR_14 | write.test.ts | #4: `suppressAutoCategories=true` skips categorize |
| WR_15 | write.test.ts | #4: `suppressAutoCategories=false` fires categorize |
| WR_16 | write.test.ts | #4: omitting option fires categorize (default) |
| MCP_PROV_01 | tools.test.ts | #5: no separate `SET m.tags` runWrite (dead-code removed) |
| WR_35 (updated) | write.test.ts | #5: explicit tags merge with old tags (provenance) |
| MCP_BATCH_DEDUP_01 | tools.test.ts | #6: exact duplicate within batch is skipped |
| MCP_BATCH_DEDUP_02 | tools.test.ts | #6: case/whitespace-normalized duplicates caught |
| MCP_BATCH_DEDUP_03 | tools.test.ts | #6: distinct items all processed normally |
| MCP_BATCH_DEDUP_04 | tools.test.ts | #6: intra-batch dedup only applies to STORE intents |

### Files Modified (4 source + 2 test)

**Source:**
1. `lib/search/hybrid.ts` — `updatedAt` in `HybridSearchResult` interface + hydration Cypher
2. `lib/mcp/server.ts` — all 6 improvements: `updated_at` mapping, `total_matching`, tag warning, `suppress_auto_categories` schema+passthrough, dead-code removal, intra-batch dedup
3. `lib/memory/write.ts` — `suppressAutoCategories` in `AddMemoryOptions` + `addMemory()`, provenance tag merge in `supersedeMemory()`

**Tests:**
1. `tests/unit/mcp/tools.test.ts` — 16 new tests + 2 existing mocks updated for `updatedAt`
2. `tests/unit/memory/write.test.ts` — 3 new tests (WR_14–16), 1 updated (WR_35)

### Verification
- `tsc --noEmit`: **0 errors**
- `jest --runInBand --no-coverage`: **49 suites / 480 tests — 0 failures** (up from 48/434)

---

## Session 19 — MCP Tool Description Rewrite + Agentic Audit (2026-03-01)

### Phase 1: Dev Server Restart + Copilot Instructions
- Restarted dev server after Session 18 changes
- Added "Restart Dev Server After Significant Changes" section to `.github/copilot-instructions.md`

### Phase 2: MCP Tool Description Rewrite
- Rewrote all MCP tool descriptions in `lib/mcp/server.ts` to be intent-driven (removed BM25, vector, RRF, dedup pipeline references)
- Recreated `.github/instructions/openmemory.instructions.md` with intent-focused content, decision tables, tags vs categories comparison, structured response examples

### Phase 3: Agentic Architect Audit (MCP LTM Stress Test)

Full read-only codebase audit across 6 layers using MemForge MCP as long-term memory. This audit tests the **Session 18 improvements** (total_matching, tag_filter_warning, updated_at, SUPERSEDE provenance, suppress_auto_categories, intra-batch dedup) in a live agentic workflow.

### MCP Tool Usage Statistics

| # | Tool | Mode | Purpose | Result |
|---|------|------|---------|--------|
| 1 | search_memory | browse (tag: audit-session-19) | Cold-start: session-tagged count | 0 results (fresh tag) |
| 2 | search_memory | browse (no tag, limit:3) | Total inventory | 93 total memories |
| 3 | search_memory | search + tag mem0ai/mem0 | Carryover recovery | 19 matching (total_matching working), 10 returned |
| 4 | add_memories | batch (4) | Store Layer 1-4 findings | 3 stored, 1 skipped (dedup) |
| 5 | add_memories | batch (4) | Store Layer 4-6 findings | 2 stored, 2 superseded |
| 6 | add_memories | batch (3) | Store remaining findings | 3 stored, 1 superseded |
| 7 | search_memory | search + tag audit-session-19 | Recovery Test 1: specific finding | 5 results, top at 0.98, tag_filter_warning fired |
| 8 | search_memory | search + tag mem0ai/mem0 | Recovery Test 2: security findings | 5 results, top at 0.98 (cross-session) |
| 9 | search_memory | browse + tag audit-session-19 | Recovery Test 3: browse inventory | 11/11 (100% recall) |
| 10 | search_memory | search + tag audit-session-19 | Recovery Test 4: semantic paraphrase | 5 results, top at 0.99 (zero keyword overlap) |
| 11 | search_memory | search (no tag) | Recovery Test 5: cross-session perf | 10 results across sessions 7,14,19 |
| **Totals** | **3 add / 8 search** | | **11 items sent** | **8 stored, 3 superseded/skipped** |

### Session 18 Feature Verification (Live)

| Feature | Status | Evidence |
|---------|--------|----------|
| `total_matching` | **WORKING** | Recovery Test 1: `total_matching: 19` vs 10 returned; Test 5: `total_matching: 10` |
| `tag_filter_warning` | **WORKING** | Tests 1,4: "Tag filter 'audit-session-19' matched only 8/9 of 34/35 search results" |
| `updated_at` | **WORKING** | All search results include `updated_at` field with ISO timestamps |
| SUPERSEDE provenance | **WORKING** | CLASSIFY-CODE-FENCE-01 has tags from BOTH sessions: `["audit-session-19", "audit-session-17"]` |
| `suppress_auto_categories` | NOT TESTED | Not provided in calls — would need explicit testing |
| Intra-batch dedup | NOT TESTED | No duplicate content within batches |

### Findings Stored (11 total)

| ID | Severity | Layer | Status |
|----|----------|-------|--------|
| ENTITY-RELTYPE-MISMATCH-01 | HIGH-BUG | Entity | **NEW** — `r.relType` vs `r.type` property name mismatch |
| HOOK-APPS-UPDATE-BROKEN-CONFIRMED | HIGH | Frontend | Carryover confirmed |
| PAUSE-NO-INVALIDAT-CONFIRMED | MEDIUM | Write | Carryover confirmed |
| FILTER-FULLSCAN-CONFIRMED | MEDIUM-PERF | API | Carryover confirmed |
| CLASSIFY-CODE-FENCE-01 | LOW | MCP | NEW (inherited tags from session 17 via SUPERSEDE) |
| APPS-NO-TRYCATCH-CONFIRMED | MEDIUM | API | Carryover confirmed |
| RELATE-EMPTY-DESC-DUPLICATE-EDGE-01 | LOW | Entity | NEW |
| CLUSTER-SUBCOMMUNITY-NAIVE-01 | LOW | Clusters | NEW |
| BACKUP-EXPORT-EMBEDDING-BLOAT-01 | LOW | API | NEW (inherited tags from session 14) |
| HISTORY-NO-GRAPH-EDGES-01 | LOW | API | NEW |
| MCP-SUPERSEDE-TAG-DEAD-CODE-CONFIRMED | LOW | MCP | Carryover confirmed |

### MCP Tool Scenario Evaluation

| Scenario | Calls | Usefulness | Verdict |
|----------|-------|------------|---------|
| Cold-start inventory (browse) | 2 | 10/10 | ESSENTIAL — confirms session state before writing |
| Carryover recovery (search + tag) | 1 | 10/10 | KEY VALUE — `total_matching: 19` shows scope beyond limit |
| Batched write (add_memories) | 3 | 9/10 | RELIABLE — 0 errors, 3 correct SUPERSEDE events |
| Tag-scoped browse (ground truth) | 1 | 10/10 | GROUND TRUTH — 11/11 recall |
| Semantic search + tag (recovery) | 2 | 10/10 | STRONG — 0.98-0.99 relevance on paraphrased queries |
| Cross-session search (no tag) | 1 | 10/10 | EXCEPTIONAL — findings from sessions 7,14,19 blended |
| Tag filter warning (new in S18) | 2 | 9/10 | ACTIONABLE — correctly advised switch to browse mode |

### Recovery Test Details

| # | Query (paraphrased) | Target Finding | Rank | Relevance | Arms Hit |
|---|-------------------|----------------|------|-----------|----------|
| 1 | "relationship type property name mismatch..." | ENTITY-RELTYPE-MISMATCH-01 | #1 | 0.98 | text+vector |
| 2 | "security vulnerabilities cross-user..." | HOOK-APPS-ACCESSED-NO-AUTH-01 | #1 | 0.98 | text+vector |
| 3 | browse (tag: audit-session-19) | All 11 findings | N/A | N/A | 100% recall |
| 4 | "frontend React hook sends wrong HTTP params..." | HOOK-APPS-UPDATE-BROKEN | #1 | 0.99 | text+vector |
| 5 | "performance scalability N+1 full scan..." | FILTER-FULLSCAN-CONFIRMED | #1 | 0.96 | text+vector |

**Key observation (Test 4):** Zero keyword overlap between query and stored finding — query says "React hook sends wrong HTTP parameters" while stored text says "useAppsApi.ts updateAppDetails() sends is_active as query param". Perfect semantic recall at 0.99 relevance.

### What Worked Well (Session 18 Improvements)
1. **`total_matching` field** — Agent knows 19 findings exist when only 10 returned. Critical for understanding recall scope.
2. **`tag_filter_warning`** — Correctly advised switching to browse mode when >70% of results dropped. Actionable and saved wasted follow-up queries.
3. **SUPERSEDE provenance tags** — Cross-session superseded findings retain origin session tags. CLASSIFY-CODE-FENCE-01 has `["audit-session-19", "audit-session-17"]`.
4. **`updated_at` in search results** — All results include timestamps; agents can assess freshness.
5. **Semantic recall quality** — 0.98-0.99 relevance on paraphrased queries with zero keyword overlap.
6. **Cross-session accumulation** — 93→11 session-scoped from 93 total. Tag isolation working perfectly.

### What Can Still Be Improved

1. **`suppress_auto_categories` not discoverable**: The parameter exists (Session 18) but nothing in the tool description or workflow prompted its use. For audit workflows where callers provide explicit categories, the tool should suggest setting `suppress_auto_categories: true` when `categories` is provided — either in description text or as a default-true when categories are explicit.

2. **Browse + search still mutually exclusive**: Want both "all items tagged X" (completeness from browse) AND "ranked by relevance" (from search) in one call. Current workaround: browse first for ground truth, then search for ranked results. Could add `sort_by: "relevance"` option to browse mode.

3. **Dedup across sessions still aggressive**: PAUSE-NO-INVALIDAT from session 17 was skipped (not stored) because session 9's version was semantically identical. For audit carryover confirmations, agent wants to mark "still unfixed" without creating a new memory — needs a `confirm` or `touch` intent that updates `updated_at` without dedup risk.

4. **No "finding resolved" workflow**: When a finding from a prior session is fixed, the only option is "Forget X" (delete) or natural supersede. Need a `status: "resolved"` metadata field or an `archive` intent that marks the finding as addressed without losing the knowledge.

5. **Entity enrichment latency on recovery searches**: All 5 search calls defaulted to `include_entities: true`. For audit recall queries, entity context is noise — only memory text matters. Tool description should more prominently advertise `include_entities: false` for speed.

6. **Category auto-enrichment still noisy**: Every finding gets "Technology", "Work" appended by LLM alongside explicit categories. `suppress_auto_categories` parameter exists but needs to be default-on when explicit categories are provided (see #1).

### Test Baseline (unchanged — read-only audit)
- **49 suites / 480 tests — ALL PASS**

---

## Session 20 — MCP Improvements Implementation (6 Session 19 Findings)

### Objective
Implement 6 MCP improvement opportunities identified in the Session 19 agentic audit report. All improvements add test coverage. Ensure zero regressions across the full test suite.

### Improvements Implemented

| # | ID | File(s) | Description |
|---|-----|---------|-------------|
| 1 | TOUCH intent | classify.ts, entities.ts, server.ts | New TOUCH intent — "Still relevant: X" / "Confirm X" refreshes `updatedAt` timestamp on best-match memory without creating a new memory or triggering dedup |
| 2 | RESOLVE intent | classify.ts, entities.ts, server.ts | New RESOLVE intent — "Resolved: X" / "Mark as fixed: X" sets `state='resolved'` + `invalidAt=now` on best-match memory, archiving it from live queries |
| 3 | Auto-suppress categories | server.ts | `suppress_auto_categories` auto-defaults to `true` when caller provides non-empty `categories[]` — eliminates noisy LLM-assigned "Technology"/"Work" categories when explicit labels are provided |
| 4 | Tag recall minimum topK | server.ts | Tag-filtered searches guarantee `topK >= 200` regardless of limit — prevents recall gaps when tag post-filter drops results from a small candidate pool |
| 5 | Tool description updates | server.ts | Updated `include_entities` description ("Set to false for faster keyword-only recall"), `suppress_auto_categories` description (documents auto-default), `add_memories` description (TOUCH + RESOLVE bullet points) |
| 6 | Instructions doc update | openmemory.instructions.md | Added TOUCH/RESOLVE to intent list, response examples, usage table. Updated `suppress_auto_categories` to document auto-default behavior |

### Architecture — TOUCH & RESOLVE Intent Pipeline

```
add_memories(content: "Still relevant: auth uses JWT")
  → classifyIntent() → mightBeCommand() regex match (/still\s+relevant/i)
  → { type: "TOUCH", target: "auth uses JWT" }
  → touchMemoryByDescription(target, userId)
    → hybridSearch(target, userId, topK=5) → best match (RRF > 0.015)
    → SET m.updatedAt = $now
    → return { id, content }
  → response: { "touched": 1 }

add_memories(content: "Resolved: CORS bug in /api/health")
  → classifyIntent() → mightBeCommand() regex match (/\bresolved\b/i)
  → { type: "RESOLVE", target: "CORS bug in /api/health" }
  → resolveMemoryByDescription(target, userId)
    → hybridSearch(target, userId, topK=5) → best match (RRF > 0.015)
    → SET m.state = 'resolved', m.invalidAt = $now, m.updatedAt = $now
    → return { id, content }
  → response: { "resolved": 1 }
```

### Bug Fixed

**Pre-existing mock leak in classify.test.ts**: `jest.clearAllMocks()` does NOT clear `mockResolvedValueOnce` queues. Test `CLASSIFY_LLM_07` ("forget my old email") doesn't match any `COMMAND_PATTERN`, queuing an LLM mock value. When the LLM wasn't called (regex short-circuit), the queued value leaked to subsequent tests. Fix: added `mockCreate.mockReset()` to module-level `beforeEach`.

### Tests Added (27 new)

| Test ID | File | Improvement |
|---------|------|-------------|
| CLASSIFY_REGEX_TOUCH_01–04 | classify.test.ts | TOUCH regex: "still relevant", "confirm", "still valid", "reconfirm" |
| CLASSIFY_REGEX_RESOLVE_01–04 | classify.test.ts | RESOLVE regex: "resolved", "mark as fixed", "has been fixed", "mark as done" |
| CLASSIFY_LLM_TOUCH_01–03 | classify.test.ts | TOUCH LLM: valid target, missing target→STORE, non-string target→STORE |
| CLASSIFY_LLM_RESOLVE_01–03 | classify.test.ts | RESOLVE LLM: valid target, missing target→STORE, non-string target→STORE |
| MCP_CAT_AUTO_SUPPRESS_01–04 | tools.test.ts | Auto-suppress: cats+no flag→true, cats+false→false, no cats→false, empty cats→false |
| MCP_TOUCH_01–03 | tools.test.ts | TOUCH: match found, no match, doesn't trigger dedup/addMemory |
| MCP_RESOLVE_01–03 | tools.test.ts | RESOLVE: match found, no match, doesn't trigger dedup/addMemory |
| MCP_TAG_RECALL_MIN_01–03 | tools.test.ts | Tag minimum topK=200, no tag uses normal multiplier, high limit×10>200 |

### Existing Tests Updated (2)

| Test | Change |
|------|--------|
| MCP_CAT_SUPPRESS_02 | Expected `suppressAutoCategories: true` (was false) — auto-default when categories provided |
| MCP_FILTER_FETCH_02 | Expected topK=200 (was 40) — tag filter minimum floor |

### Files Modified (5 source + 2 test + 1 doc)

**Source:**
1. `lib/mcp/classify.ts` — TOUCH + RESOLVE intents (types, regex, LLM prompt, parser)
2. `lib/mcp/entities.ts` — `touchMemoryByDescription()` + `resolveMemoryByDescription()`
3. `lib/mcp/server.ts` — TOUCH/RESOLVE handlers, auto-suppress, tag recall floor, descriptions

**Tests:**
4. `tests/unit/mcp/classify.test.ts` — 14 new tests + mockReset leak fix
5. `tests/unit/mcp/tools.test.ts` — 13 new tests + 2 updated

**Docs:**
6. `.github/instructions/openmemory.instructions.md` — TOUCH/RESOLVE intents, response examples, usage table, suppress_auto_categories

### Verification
- `tsc --noEmit`: **0 errors**
- `jest --runInBand --no-coverage`: **49 suites / 507 tests — 0 failures** (up from 480)

---

## Session 21 — Agentic Architect Audit (MCP LTM, Full Codebase) (2026-03-01)

### Objective
Full read-only codebase audit across 8 layers (DB, write pipeline, search, entity, MCP server, API routes, frontend, config/infra) using MemForge MCP as long-term memory. Verifies which prior session findings have been fixed, identifies new findings, and tests Session 20 MCP improvements in a live agentic workflow.

### MCP Tool Usage Statistics

| # | Tool | Mode | Purpose | Result |
|---|------|------|---------|--------|
| 1 | search_memory | browse (tag: audit-session-21) | Cold-start: session-tagged count | 0 results (fresh tag) |
| 2 | search_memory | browse (no tag, limit:3) | Total inventory | 101 total memories |
| 3 | search_memory | search (no tag) | Carryover recovery | 19 matching results |
| 4-6 | add_memories | batch (4×3) | Store findings | 8 stored, 4 superseded |
| 7 | search_memory | browse + tag | Full inventory verification | 12/12 (100% recall) |
| 8 | search_memory | search + tag | Recovery Test 1: security | 5 results, top at 0.94 |
| 9 | search_memory | search + tag | Recovery Test 2: entity reltype semantic | RELTYPE-MISMATCH at rank #1 (1.0 relevance, dual-arm) |
| **Totals** | **3 add / 6 search** | | **12 items sent** | **8 stored, 4 superseded** |

### Findings Stored (12 total)

| ID | Severity | Layer | Status |
|----|----------|-------|--------|
| ACCESSED-NO-USER-ANCHOR-01 | HIGH-SECURITY | API | NEW — accessed route has no User anchor |
| ENTITY-RELTYPE-MISMATCH-CONFIRMED | HIGH-BUG | Entity | SUPERSEDED prior — r.relType vs r.type |
| HOOK-APPS-UPDATE-DOUBLE-BROKEN | HIGH | Frontend | SUPERSEDED prior — missing user_id + wrong param location |
| APPS-MEMORIES-NO-INVALIDAT-01 | MEDIUM | API | NEW — missing bitemporal guard + cross-user count |
| CONFIG-NO-AUTH-01 | MEDIUM-SECURITY | Config | NEW — config API has no authentication |
| MEMORYID-PUT-NO-ENTITY-EXTRACT-01 | MEDIUM | API | SUPERSEDED prior — REST PUT no entity extraction |
| PAUSE-NO-INVALIDAT-STILL-UNFIXED | MEDIUM | Write | Carryover confirmed |
| FILTER-FULLSCAN-STILL-UNFIXED | MEDIUM-PERF | API | Carryover confirmed |
| CATEGORIES-NO-INVALIDAT-01 | LOW | API | NEW — categories route counts superseded memories |
| REEXTRACT-NO-FILTER-01 | LOW | API | NEW — reextract processes deleted/superseded memories |
| DB-CLOSE-NO-LIFECYCLE-STILL-UNFIXED | LOW | DB | SUPERSEDED prior — closeDriver not on SIGTERM |
| Session 21 FIXED verification | N/A | Meta | 6 prior findings verified FIXED |

### Verified FIXED (6 prior findings)

| ID | Session Fixed | Evidence |
|----|---------------|----------|
| WRITE-SUPERSEDE-NOT-ATOMIC-01 | Session 15 | `supersedeMemory()` is single Cypher with inline MERGE |
| WRITE-ARCHIVE-NO-INVALIDAT-01 | Session 15 | `archiveMemory()` sets `m.invalidAt = $now` |
| SEARCH-HYDRATE-NO-BITEMPORAL-01 | Session 15 | Hydration UNWIND has `WHERE m.invalidAt IS NULL` |
| MCP-SUPERSEDE-TAG-DEAD-CODE | Session 18 | Dead-code `SET m.tags` runWrite removed |
| API-APPS-NO-USER-ANCHOR-01 | Session 15 | GET anchors through `(u:User {userId: $userId})-[:HAS_APP]->(a:App)` |
| API-APPS-PUT-NO-AUTH-01 | Session 15 | PUT requires user_id and anchors through User |

### Key New Finding Details

**ACCESSED-NO-USER-ANCHOR-01 (HIGH-SECURITY):**
`apps/[appId]/accessed/route.ts` — Both data and count queries use `MATCH (a:App)-[acc:ACCESSED]->(m:Memory)` with NO User scope. Any user knowing an app name can see any other user's accessed memories. Does not even accept `user_id` parameter. Also missing `m.invalidAt IS NULL`.

**ENTITY-RELTYPE-MISMATCH-CONFIRMED (HIGH-BUG):**
`lib/mcp/entities.ts` L148+L156 reads `r.relType` but `lib/entities/relate.ts` stores edges with property `type`. The UNWIND batch relationship enrichment in `searchEntities()` always returns `null` for relationship types. `summarize-entity.ts` correctly uses `r.type AS relType`. Fix: change `r.relType` to `r.type` in both UNION arms.

**HOOK-APPS-UPDATE-DOUBLE-BROKEN (HIGH):**
`useAppsApi.ts updateAppDetails()` sends `PUT /api/v1/apps/${appId}?is_active=${details.is_active}` — TWO bugs: (1) missing `user_id` query param so PUT always returns 400, (2) `is_active` is in query params but the backend `PUT` handler reads from `request.json()` body. The entire update flow is dead code.

**CONFIG-NO-AUTH-01 (MEDIUM-SECURITY):**
`GET/PUT/PATCH /api/v1/config` has zero authentication — no `user_id` required. Any caller can read or modify global configuration (dedup thresholds, context window, etc). Config nodes are standalone. In multi-user deployments, this is a privilege escalation vector.

### Session 20 MCP Feature Verification (Live)

| Feature | Status | Evidence |
|---------|--------|----------|
| `total_matching` | **WORKING** | Recovery Test 1: `total_matching: 5`; Test 2: `total_matching: 23` |
| `tag_filter_warning` | **WORKING** | Test 1: "Tag filter 'audit-session-21' matched only 5 of 31 search results" |
| `updated_at` | **WORKING** | All search results include `updated_at` with ISO timestamps |
| SUPERSEDE provenance | **WORKING** | ENTITY-RELTYPE-MISMATCH has tags from both sessions: `["audit-session-21", "audit-session-19"]` |
| TOUCH/RESOLVE intents | NOT TESTED | No matching use case in this audit |
| Auto-suppress categories | **WORKING** | Explicit `categories` provided → no extra LLM categories on most items |

### MCP Tool Evaluation

| Scenario | Calls | Verdict |
|----------|-------|---------|
| Cold-start inventory (browse) | 2 | ESSENTIAL — confirmed 101 total, 0 session-tagged |
| Carryover recovery (search) | 1 | KEY VALUE — 19 prior findings recovered |
| Batched write (add_memories) | 3 | RELIABLE — 0 errors, 4 correct SUPERSEDEs |
| Tag-scoped browse (ground truth) | 1 | GROUND TRUTH — 12/12 recall |
| Security query (search + tag) | 1 | STRONG — both HIGH-SEC in top 2, 0.94+ relevance |
| Semantic paraphrase (search + tag) | 1 | EXCEPTIONAL — rank #1 at 1.0 relevance with dual-arm hit |

### Test Baseline (unchanged — read-only audit)
- `tsc --noEmit`: 0 errors
- `jest --runInBand --no-coverage`: **49 suites / 507 tests — ALL PASS**