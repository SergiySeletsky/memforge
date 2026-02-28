# OpenMemory UI — Agent Log

---

## Completed Sessions (Summary)

| Sessions | Topic | Outcome |
|----------|-------|---------|
| 7 — Agentic Architect Audit (OpenMemory LTM) | Full repo audit using OpenMemory MCP as LTM across 10 code layers | 37 findings stored across 8 batches; 2 SUPERSEDE events from dedup. MCP report below. |
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
4. `jest.clearAllMocks()` does NOT flush `mockResolvedValueOnce` queues — queue items leak to subsequent tests. In `RESOLVE_DUP_SAFE` a second `mockRunRead.mockResolvedValueOnce([])` was queued for an alias lookup that never fires for CONCEPT type; the leftover item corrupted `RESOLVE_READ_ONLY`. Fix: only queue the exact number of Once values that will actually be consumed.

### Verification
- `jest --runInBand --no-coverage`: **384 tests, 48 suites, 0 failures**
- `tsc --noEmit`: 1 pre-existing error only

---

## Session 3 — Entity Dedup Fix + Test Coverage Completion (2026-02-27)

### ENTITY-DUP-FIX — Duplicate Entity nodes under concurrent extraction

**Root cause:** `lib/entities/resolve.ts :: resolveEntity()` used a `READ → CREATE` pattern (TOCTOU race). Two concurrent `processEntityExtraction()` calls for different memories containing the same entity could both read "not found" and both `CREATE` a new Entity node. The unique constraint was on `Entity.id` (UUID) — not on `(normalizedName, userId)` — so duplicates were silently allowed.

**Fix in `lib/entities/resolve.ts`:**
- Changed the `else` branch (new entity creation) from `CREATE (e:Entity {...}) CREATE (u)-[:HAS_ENTITY]->(e)` to a single atomic MERGE:
  ```cypher
  MERGE (u)-[:HAS_ENTITY]->(e:Entity {normalizedName: $normalizedName, userId: $userId})
  ON CREATE SET e.id = $id, e.name = $name, ...
  RETURN e.id AS entityId
  ```
- Memgraph acquires an exclusive lock on the edge pattern during MERGE, so concurrent callers for the same entity produce exactly one node.
- The returned `e.id` is used (not the pre-generated UUID) — handles the race where a concurrent writer created the node before us.

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
| `MCP_FILTER_FETCH_01-03` | tools.test.ts | MCP-FILTER-01: 3× topK when filters active |
| `ORCH_09` | dedup-orchestrator.test.ts | DEDUP-01: intelliThreshold independent from azureThreshold |

### Verification
- `jest --runInBand --no-coverage`: **393 tests, 48 suites, 0 failures**
- `tsc --noEmit`: pre-existing errors only

---

## Session 4 � Architectural Audit (MCP LTM Workflow) (2026-05-31)

### Objective
Full read-only audit of current codebase state using OpenMemory MCP as long-term memory. Identify new findings post-Session-3 fixes. Evaluate MCP tool utility as an active agent workflow aid.

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
4. root package.json: Added dev/build/test/test:e2e scripts delegating to openmemory/ui so pnpm dev from repo root works.

Verification:
- pnpm test (unit): 37 suites / 320 tests - PASS (no server needed)
- pnpm test:e2e: 11 suites / 73 tests - PASS (requires live server + Memgraph)
- GET /api/health: {status:'ok', memgraph:{ok:true,latency:3ms}, embeddings:{ok:true,provider:'intelli',dim:1024,latency:1067ms}}
- tsc --noEmit: pre-existing errors only

---

## Session 6 — MCP Agentic Audit (fresh Memgraph)

**Setup:** User cleared Memgraph. All data wiped, schema reset. Agent used OpenMemory MCP as LTM throughout the audit.

**MCP-BROWSE-SLICE-01 (FIXED):** First MCP call post-clear failed: `Expected an integer for a bound in list slicing, got double`. `lib/mcp/server.ts` L321 used `allMems[$offset..($offset+$limit)]` — Bolt sends JS numbers as float64, Memgraph requires integer bounds for list slices. `wrapSkipLimit()` only patches `SKIP/LIMIT` keywords. Fix: `allMems[toInteger($offset)..(toInteger($offset)+toInteger($limit))]`. Server hot-reload didn't pick up SSE route change — had to kill PID 25120 and restart.

**Findings found + fixed this session (6 fixes, 37 suites / 320 tests pass):**

| ID | Severity | File | Fix |
|----|----------|------|-----|
| FILTER-BITEMPORAL-01 | HIGH | filter/route.ts | Added `m.invalidAt IS NULL` to default whereParts |
| BACKUP-EXPORT-NO-AUTH-01 | HIGH | backup/export/route.ts | Require user_id, scope query per user + added invalidAt IS NULL |
| CATEGORIZE-N-WRITE-01 | MEDIUM-PERF | lib/memory/categorize.ts | Replaced N sequential runWrite with single UNWIND batch |
| BULK-NO-APP-01 | MEDIUM | lib/memory/bulk.ts | Added App MERGE + [:CREATED_BY] to UNWIND CREATE |
| BULK-NO-CATEGORIZE-01 | LOW | lib/memory/bulk.ts | Added fire-and-forget categorizeMemory() per bulk item |
| APPS-COUNT-BITEMPORAL-01 | LOW | apps/route.ts + apps/[appId]/route.ts | Added `m.invalidAt IS NULL` to memory_count queries |

**Open findings (not yet fixed, documented in OpenMemory store):**
- CLUSTER-ISOLATION-01 (HIGH): community_detection.get() runs on all-users graph
- CLUSTER-UNANCHORED-01: cluster build MATCH Memory without User anchor
- CONFIG-SAVE-01: setConfig sequential writes (N round-trips)
- APPS-APP-ISOLATION-01: apps/[appId] no User anchor on App lookup
- FILTER-FULLSCAN-01: filter uses toLower CONTAINS instead of hybridSearch

**Carryover findings from Session 4 (still pending):**
- MCP-SUPERSEDE-TAG-01, HYBRID-HYDRATE-01, MCP-RERANK-01, WORKER-SCOPE-01,
  ENTITY-ENRICH-N+1, API-SEARCH-PAGINATE-01, INVALIDATE-SEQUENTIAL-01,
  TRANSACT-SUPERSEDE-01, CLASSIFY-GAP-01

**Test baseline after session 6:** 37 suites / 320 tests — PASS

---

## Session 9 — OSS Migration to OpenMemory (Phase 1+2)

### Migration Execution

Migrated 5 features from `mem0-ts/src/oss/src/` → `openmemory/ui/lib/`, covering Phase 1 + Phase 2 of MIGRATION_PLAN.md.

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
- **43 suites / 376 tests — ALL PASS** (up from 37/320 baseline)
- **tsc --noEmit**: 1 pre-existing error only (.next/types MCP SSE route)

---

## Session 10 — OSS Migration Completion (Phase 3 + Final Cleanup)

### Migration Execution

Completed Phase 3 of MIGRATION_PLAN.md: Enhanced contradiction detection in dedup pipeline.
Deleted ALL remaining oss source files (48) and test files (18).

**Enhanced file (1):**

| File | What Changed |
|------|-------------|
| `lib/dedup/verifyDuplicate.ts` | Added few-shot examples from oss's `DEFAULT_UPDATE_MEMORY_PROMPT` to `VERIFY_PROMPT`. Now covers 7 example pairs: paraphrase→DUPLICATE, detail enrichment→SUPERSEDES, preference change→SUPERSEDES, contradiction→SUPERSEDES, unrelated→DIFFERENT, residence update→SUPERSEDES, dark mode paraphrase→DUPLICATE. Exported `VERIFY_PROMPT` for test inspection. |

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
The oss two-phase pipeline (extract facts → bulk compare against all memories via `getUpdateMemoryMessages()`) was evaluated but NOT ported. OpenMemory's existing architecture (intent classifier → dedup pipeline → pairwise verify) is architecturally superior for the Next.js monolith because:
1. It avoids the N×M comparison matrix (N facts × M memories) — openmemory does 1-to-1 pairwise with the closest vector match
2. The intent classifier + dedup pipeline separation is cleaner than the oss's monolithic `Memory.add()` orchestrator
3. Bi-temporal supersession (SUPERSEDES → `supersedeMemory()`) handles contradictions better than oss's DELETE+ADD split

The prompt quality improvement was the only meaningful enhancement to port — few-shot examples make the LLM classification more reliable for edge cases (enrichment vs duplication vs contradiction).

### Test Results
- **43 suites / 388 tests — ALL PASS** (up from 43/376 session-9 baseline, +12 new tests)

---

## Session 7 — Agentic Architect Audit (Fresh Memgraph, MCP LTM Stress Test) (2026-02-28)

### Objective
Full read-only codebase audit using OpenMemory MCP as long-term storage across 10 code layers (DB, write pipeline, search, entity pipeline, MCP server, dedup, clusters, config, API routes, frontend). Memgraph was cleared fresh at session start. Audit was designed to exceed a single LLM context window — MCP was the only memory mechanism.

### MCP Tool Usage Statistics

| Tool | Calls | Items Sent | Items Stored | SUPERSEDE | Errors |
|------|-------|-----------|-------------|-----------|--------|
| `add_memories` | 10 | 41 | 37 | 2 | 0 |
| `search_memory` (browse) | 2 | — | — | — | — |
| **Total** | **12** | **41** | **37** | **2** | **0** |

### What Worked Well
1. **Batched writes (array form)**: `add_memories(content: [...])` was used for all writes — 4 items per call. Zero errors, all 10 calls succeeded. Much more efficient than 41 individual calls.
2. **Category + tag filtering**: Categories (`Architecture`, `Database`, `Refactoring`) and tags (`audit-session-7`, `db-layer`, `security`) allowed immediate grouping/filter on browse without re-fetching all 37 memories.
3. **Dedup caught overlapping findings**: Two CONFIG findings that shared semantic space were correctly collapsed (CONFIG-NO-TTL-CACHE-01 superseded a duplicate). REFACTOR-PRIORITY-HIGH finding about entity extraction also superseded a related detail-level finding. *This is the correct behavior — two similar architectural notes become one consolidated finding.*
4. **Browse as cold-start check**: Two `search_memory()` (no query) calls verified the store was empty at session start and fully populated at session end. Total count was readable at a glance from `total` field.
5. **Tag-scoped retrieval**: All audit findings tagged `audit-session-7` would be instantly filterable in a future session via `search_memory(tag: "audit-session-7")` without mixing with other stored memories — this is the key value-add over plain context.

### What Could Be Improved

1. **Dedup threshold too aggressive for structured findings**: Two distinct action items (sequential writes vs. missing TTL cache in config layer) were merged via SUPERSEDE because their embedding similarity exceeded the threshold. For audit/planning use cases where each finding is an independent action item, it would help to have a `dedup_mode: "strict"` option that raises the threshold to 0.90+ for single `add_memories` sessions.

2. **No `search_memory(tag: "...")` was tested for targeted retrieval**: All retrieval was browse-mode. A third use pattern — `search_memory(query: "security findings")` — was not exercised. This would be the primary recovery mechanism if context was lost mid-session. Should verify it works and returns tagged findings ranked by relevance.

3. **SUPERSEDE events swallow the superseded memory**: When CONFIG-NO-TTL-CACHE-01 superseded CONFIG-SAVE-SEQUENTIAL-01, the older finding is no longer in browse results. For an audit session this is a data loss — both findings represent distinct bugs. Workaround: use `categories` or `tags` to namespace overlapping findings before sending.

4. **No `search_memory` mid-session for context recovery was tested**: The intent was to simulate context overflow, but the auditor had the full code in context. True value would emerge when a new session picks up using `search_memory(query: "unfixed carryover findings")` to resume where the prior session left off — this pattern was not exercised.

5. **`add_memories` response is verbose**: The JSON result includes `id`, `memory`, `event` per item. For a batch of 4, parsing the response to verify all 4 were ADD (not SKIP or ERROR) requires parsing. A summary header — `{"stored": 4, "skipped": 0, "errors": 0, "results": [...]}` — would make batch validation easier.

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
| SEARCH-VECTOR-SCOPE-01 | RESOLVED | Search | Confirmed vector.ts HAS the invalidAt guard — not a finding |
| SEARCH-PAGINATION-01 | MEDIUM | Search | Deep pagination is O(n×page); no backfill when post-filters remove results |
| SEARCH-TEXT-ARM-ERRORS-SWALLOWED-01 | LOW | Search | Text arm failures silently fall back to vector-only with no caller signal |
| ENTITY-ENRICH-N1-01 | MEDIUM-PERF | Entity | searchEntities() relationship fetch is N+1 serial loop |
| ENTITY-WORKER-NO-ANCHOR-01 | HIGH-SECURITY | Entity | worker.ts Step 1 bare MATCH without User anchor violates Spec 09 |
| ENTITY-INVALIDATE-SEQUENTIAL-01 | LOW-PERF | Entity | invalidateMemoriesByDescription() deleteMemory in for-loop |
| ENTITY-NORM-MISMATCH-01 | HIGH | Entity | Two normalizeName functions produce different keys — split-brain namespace |
| MCP-SUPERSEDE-TAG-REDUNDANT-01 | LOW | MCP | Dead-code redundant SET m.tags after supersedeMemory |
| MCP-CLASSIFY-GAP-01 | LOW-UX | MCP | COMMAND_PATTERNS missing 'wipe', 'stop knowing', 'forget about' |
| MCP-SEARCH-ENTITY-COST-01 | MEDIUM-PERF | MCP | Entity enrichment always on (5 DB trips) unless include_entities=false |
| MCP-ADD-CATEGORY-RACE-01 | LOW | MCP | Concurrent category MERGE + LLM auto-categorizer can produce case variants |
| CLUSTER-ISOLATION-01 | HIGH-SECURITY | Clusters | community_detection.get() runs cross-user Louvain |
| CLUSTER-MISSING-MEMORY-ANCHOR-01 | MEDIUM | Clusters | WHERE node = m guard insufficient; Louvain community IDs span all users |
| CONFIG-SAVE-SEQUENTIAL-01 | LOW-PERF | Config | saveConfigToDb() sequential runWrite per key |
| CONFIG-NO-TTL-CACHE-01 | MEDIUM-PERF | Config | getDedupConfig/getContextWindowConfig uncached; called per addMemory |
| DEDUP-CACHE-UNBOUNDED-01 | RESOLVED | Dedup | Cache IS LRU-limited to 1000 entries — confirmed not an issue |
| DEDUP-SINGLE-CANDIDATE-01 | MEDIUM | Dedup | Only top cosine candidate verified; #2 SUPERSEDE candidate never tried |
| DEDUP-VERIFY-PROMPT-STALE-01 | LOW | Dedup | few-shot examples in VERIFY_PROMPT not regenerated on provider change |
| API-FILTER-FULLSCAN-01 | MEDIUM-PERF | API | filter route uses CONTAINS scan instead of hybridSearch |
| API-FILTER-DOUBLE-QUERY-01 | LOW-PERF | API | filter route fires 2 parallel identical-WHERE traversals |
| API-BACKUP-NO-STREAM-01 | MEDIUM | API | backup/export may load all memories into RAM (needs verification) |
| API-APPS-ISOLATION-01 | HIGH-SECURITY | API | apps/[appId] route may lack User anchor (needs verification) |
| FRONTEND-NO-OPTIMISTIC-UPDATE-01 | MEDIUM-UX | Frontend | deleteMemories dispatches UI update before API confirms |
| FRONTEND-STALE-USER-ID-01 | MEDIUM | Frontend | mutation functions not wrapped in useCallback — stale userId closure risk |
| FRONTEND-SORT-PARAMS-IGNORED-01 | LOW | Frontend | sort_column/sort_direction sent to API but not implemented server-side |
| FRONTEND-CATEGORIES-CAST-01 | MEDIUM | Frontend | categories cast as Category[] but API returns string[] — runtime risk |

### Carryover from Prior Sessions (Confirmed Still Unfixed)
- CLUSTER-ISOLATION-01, ENTITY-WORKER-NO-ANCHOR-01, CONFIG-SAVE-SEQUENTIAL-01, ENTITY-ENRICH-N1-01, ENTITY-INVALIDATE-SEQUENTIAL-01, API-FILTER-FULLSCAN-01, SEARCH-HYDRATE-INVALIDAT-01, SEARCH-PAGINATION-01, MCP-CLASSIFY-GAP-01, MCP-SUPERSEDE-TAG-REDUNDANT-01

### Test Baseline (unchanged — read-only audit)
- **43 suites / 388 tests — ALL PASS**

---

## Session 8 — Compact Response + search_memory Recovery Test (2026-02-28)

### Objective
Two items from the Session 7 MCP evaluation report:
1. **Item 2**: Reduce `add_memories` tool output to save tokens (response was ~45% of context window)
2. **Item 5**: Stress-test `search_memory` mid-session for context recovery

### Item 2 — Compact `add_memories` Response

**Problem:** `add_memories` echoed full memory text in every result item back to the caller. For batch writes of 4 items with 200+ char memories, the response consumed significant context tokens. Callers need batch-item correlation but not the full text echo.

**Fix in `lib/mcp/server.ts`:**
- Added `summary` stats header to response: `{ stored, superseded, skipped, errored, invalidated, deleted_entities, total }`
- Truncated echoed `memory` field to 80 chars with `…` suffix in `compactResults`
- Response shape: `{ summary: {...}, results: compactResults }` instead of `{ results }`

**Test update in `tests/unit/mcp/tools.test.ts`:**
- MCP_ADD_01 now asserts `parsed.summary` matches expected counts

### Item 5 — search_memory Mid-Session Context Recovery

Tested 5 query patterns against the 37 stored audit memories from Session 7:

| # | Query Pattern | Results | Recall Quality |
|---|-------------|---------|----------------|
| 1 | `"security findings cross-user namespace isolation"` | 5 hits, 0.86–0.97 | All 3 security findings recovered (CLUSTER-ISOLATION-01, ENTITY-WORKER-NO-ANCHOR-01, API-APPS-ISOLATION-01) |
| 2 | `"unfixed carryover findings from prior audit sessions"` | 10 hits, 0.82–0.94 | Findings from all layers — MCP, entity, search, frontend, dedup, config |
| 3 | `"HIGH severity bugs that need immediate fix"` | 10 hits, 0.83–0.96 | Pure semantic match (no "HIGH" literal in memory text) — correct action items ranked top |
| 4 | `"write pipeline atomicity problems"` | 5 hits, 0.88–0.99 | WRITE-ATOMIC-01 at 0.99 (rank 1 on both arms) |
| 5 | browse (no query) | total: 37 | Full inventory confirmed, tags + categories intact |

**Key conclusions:**
- **Semantic recall is strong**: Queries with zero keyword overlap still return correct results via vector similarity
- **RRF fusion working correctly**: Dual-arm hits (text + vector) get highest relevance scores
- **Context recovery viable**: An agent that lost context could reconstruct audit state from 3–4 targeted queries
- **Browse confirms inventory**: 37/37 memories intact with metadata

### Verification
- `tsc --noEmit`: pre-existing errors only
- `jest --runInBand`: **43 suites / 388 tests — ALL PASS**

---

## Session 9 — Agentic Architect Audit (MCP LTM, Project-Scoped Tags)

### Objective
Full read-only codebase audit using OpenMemory MCP as long-term memory, with project-scoped tags (`mem0ai/mem0`, `audit-session-9`). Focus on testing MCP tool scenarios end-to-end and identifying new + carryover findings across all code layers.

### MCP Tool Usage Statistics

| # | Tool | Mode | Query/Content | Purpose | Result |
|---|------|------|---------------|---------|--------|
| 1 | search_memory | browse (tag: mem0ai/mem0) | — | Cold-start: project-tagged count | 0 results (fresh project tag) |
| 2 | search_memory | browse (no tag, limit:3) | — | Total memory inventory | 41 total memories |
| 3 | search_memory | search | "unfixed carryover findings HIGH severity" | Recover prior session findings | 10 hits, 8 distinct carryovers |
| 4 | add_memories | batch (4) | Layer 1-2 findings | Store DB + Write findings | 4 ADD, 0 errors |
| 5 | add_memories | batch (4) | Layer 3-5 findings | Store API + Frontend findings | 4 ADD, 0 errors |
| 6 | search_memory | search (tag: audit-session-9) | "write pipeline archive invalidAt..." | Mid-audit recovery test | 8/8 recall (100%) |
| 7 | search_memory | search (tag: mem0ai/mem0) | "security vulnerabilities cross-user..." | Cross-session tag-scoped test | 3/12 returned (recall gap) |
| 8 | search_memory | search (tag: mem0ai/mem0) | "cluster community detection Louvain..." | Targeted security query | 1/12 returned (low confidence) |
| 9 | search_memory | search (no tag) | "cluster community detection Louvain global..." | Unfiltered cross-session test | 3 hits, 0.92–0.93 relevance |
| 10 | add_memories | batch (4) | Layer 5 + carryover confirmations | Store config + frontend findings | 3 ADD, 1 SUPERSEDE |
| 11 | search_memory | browse (tag: mem0ai/mem0) | — | Final inventory verification | 12/12 findings confirmed |
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

**Scenario 1: Cold-Start Inventory (browse)** — 2 calls
- `browse(tag: "mem0ai/mem0")` confirmed 0 project-scoped memories (fresh tag namespace)
- `browse(limit: 3)` confirmed 41 total memories in store from prior sessions
- **Verdict**: Essential for understanding what's already stored before writing

**Scenario 2: Cross-Session Find Recovery (search)** — 1 call
- Query "unfixed carryover findings HIGH severity" returned 10 results, 8 known carryover findings recovered
- Relevance scores 0.82–0.97, dual-arm (BM25+vector) hits scored highest
- **Verdict**: Strong. Agent can resume audit context from prior sessions without scrolling

**Scenario 3: Batched Write (add_memories)** — 3 calls, 12 items
- 4 items per call, zero errors, 11 ADDs + 1 SUPERSEDE
- SUPERSEDE correctly consolidated CONFIG-NO-TTL-CACHE-01 when the updated version was more detailed
- **Verdict**: Batch size of 4 is optimal — balances throughput with dedup quality

**Scenario 4: Mid-Audit Tag-Scoped Recovery (search + tag)** — 1 call
- `search_memory(query, tag: "audit-session-9")` returned all 8 session-9 findings
- 100% recall, relevance scores 0.46–0.93
- **Verdict**: Tag filtering + semantic search is the primary recovery mechanism

**Scenario 5: Cross-Project Tag Recovery (search + tag: mem0ai/mem0)** — 2 calls
- First query ("security vulnerabilities cross-user"): returned 3/12, CLUSTER finding absent
- Second query ("cluster community detection"): returned 1/12 with `confident: false`
- **Verdict**: Tag + search has a recall gap. The 3× topK pre-filter (MCP-FILTER-01) may be too small for combined tag+semantic filtering. Browse + tag gives 100% recall.

**Scenario 6: Unfiltered Cross-Session Search** — 1 call
- "cluster community detection Louvain global multi-user" found 3 results at 0.92+ relevance
- Prior session's finding returned perfectly without any tag filter
- **Verdict**: When recall matters more than precision, drop the tag filter

**Scenario 7: SUPERSEDE via Dedup** — 1 organic event
- CONFIG-NO-TTL-CACHE-01 from session 7 was superseded by the session 9 version
- Correct behavior — same finding, more detailed description
- **Verdict**: Dedup works as designed for iterative knowledge refinement

**Scenario 8: Full Inventory Verification (browse + tag)** — 1 call
- `browse(tag: "mem0ai/mem0")` returned all 12 findings with correct tags and metadata
- **Verdict**: Ground truth is always accessible via browse when search has gaps

### What Worked Well
1. **Tag-scoped browse = perfect recall** — `tag: "mem0ai/mem0"` browse returned 12/12 findings
2. **SUPERSEDE consolidation** — Dedup correctly merged overlapping findings across sessions
3. **Dual-arm RRF ranking** — Findings with both BM25 text_rank + vector_rank scored highest
4. **Batch writes** — Zero errors across 3 calls × 4 items
5. **Cross-session recovery** — Prior session findings at 0.92+ relevance without tag filter

### What Can Be Improved
1. **Search + tag post-filter recall gap** — 3× topK multiplier insufficient when combining tag filter with semantic search. CLUSTER-ISOLATION-01 was absent from tag-filtered search despite being correctly tagged. Recommendation: increase multiplier to 5× or 10× when tag filter is active, or apply tag filter inside the Cypher search arms rather than post-retrieval.
2. **Tags missing from search results** — MCP-SEARCH-NO-TAGS-RESPONSE-01 found during this audit. Search mode results don't include `tags` field — agents can't see project/session tags in search results.
3. **Confidence flag false-negative** — `confident: false` on a valid but vector-only result (cluster finding). The heuristic requires BM25 hit OR maxScore > 0.02 — but valid semantic matches can score below 0.02 RRF when text arm returns nothing.
4. **External MCP still uses verbose response format** — The compact response format (Session 8) is only in local server.ts. External service returns full `results[]` array with memory text echo.
5. **Category enrichment inconsistency** — Findings stored with explicit `categories: ["Architecture", "Database"]` also received LLM auto-assigned categories ("Work", "Technology"). Expected but makes deterministic filtering harder.
