# OpenMemory UI — Agent Log

## Summary

Running project log for all agent sessions. Most recent entries at bottom.

---

## Session 1 — Workspace Configuration & App Fix

### Changes Made

**Root workspace (`c:\Users\Selet\source\repos\mem0\mem0`)**
- `package.json`: Added `"type": "module"`, `scripts` (lint, format, format:check), and shared `devDependencies`: `@eslint/js@^9`, `@types/node@^22`, `dotenv@^16`, `eslint@^9`, `jest@^29.7.0`, `prettier@^3.5.2`, `ts-jest@^29.4.6`, `typescript@5.5.4`, `typescript-eslint@^8`
- `.npmrc` (NEW): `shamefully-hoist=true` — required for Next.js on Windows with pnpm workspaces (see Patterns section)
- `prettier.config.js` (NEW): Shared Prettier config (`printWidth:100`, double quotes, trailing commas, LF line endings)
- `.prettierignore` (NEW): Excludes `node_modules`, `dist`, `.next`, lock files, coverage
- `eslint.config.js` (NEW): ESLint 9 flat config with `typescript-eslint@8`; warns on `no-explicit-any`; test file overrides

**`mem0-ts/`**
- `package.json`: Removed hoisted devDeps; added `@types/sqlite3@^3.1.11`
- `tsconfig.json`: Excluded `src/community` (has own tsconfig + unresolvable peers)
- `src/oss/src/types/index.ts`: Added `timeout?: number`, `maxRetries?: number` to `LLMConfig`
- `src/oss/src/reranker/index.ts`: Split `export type` from value exports (isolatedModules compliance)
- `src/client/mem0.ts`: 3x `@ts-ignore` → `@ts-expect-error` with inline justification
- `src/client/telemetry.ts`: Removed `@ts-nocheck`; typed `additionalData` param; annotated empty catch
- `src/oss/src/llms/langchain.ts`: Removed empty `else {}`; removed useless re-throw try/catch
- `src/oss/src/memory/index.ts`: Annotated empty telemetry catch
- `src/oss/src/reranker/cohere.ts`: `eslint-disable-next-line` for lazy `require()`
- `src/oss/src/vector_stores/redis.ts`: `Number(x) ?? 0` → `Number(x) || 0` (NaN is falsy, not null)
- `src/oss/src/utils/telemetry.ts`: Annotated empty env-check catch

**`openmemory/ui/`**
- `package.json`: Removed hoisted devDeps; downgraded `@jest/globals`, `@types/jest`, `jest-environment-node` from `@30` → `@29` (to match hoisted `jest@29`)
- `tsconfig.json`: Added `jest.config.ts` and `jest.e2e.config.ts` to `exclude` (prevents `@types/jest@29` ambient declaration conflict)
- `components/Navbar.tsx`: Added `if (!pathname) return false` guard in `isActive()` (fixes null crash during SSR hydration)
- `next.config.mjs`: Added `serverExternalPackages: ["neo4j-driver"]` and custom webpack externals for `neo4j-driver`

**`.github/copilot-instructions.md`**
- Appended Core Execution Framework: Autonomy Mandate, Execution Protocol, Error Recovery (4-tier table), State Management (AGENTS.md), Playwright MCP monitoring
- Appended Quality Gates: TypeScript gates, Testing gates (≥90% coverage), Enforcement rules

### Verification Run
- `pnpm exec tsc --noEmit` in `mem0-ts`: **0 errors**
- ESLint on `mem0-ts`: **0 errors**, 263 warnings (all in test files, intentional `no-explicit-any`)
- `openmemory/ui` TS: **1 pre-existing error** (`entities/[entityId]/route.ts` — params not Promise, known Next.js 15 issue)
- App at `http://localhost:3000`: **loads correctly**, all API routes return 200

---

## Patterns

### Windows + pnpm workspace: webpack drive-letter casing bug

**Symptom:** `invariant expected layout router to be mounted` crash on every page load; webpack console warnings: `WARNING: multiple modules with names that only differ in casing`.

**Root Cause:** pnpm's symlink-based virtual store (`node_modules/.pnpm/...`) produces inconsistent drive-letter casing on Windows (e.g. `C:\...` vs `c:\...`). Webpack on case-insensitive Windows FS treats these as two different modules, so Next.js internal modules (`layout-router.js`, `react-dom`, etc.) get bundled twice, causing the React invariant failure.

**Fix:** Add `shamefully-hoist=true` to `.npmrc` at workspace root. This makes pnpm use a flat `node_modules` layout (like npm/yarn), eliminating the symlinks that trigger the casing ambiguity. Run `pnpm install` (with `CI=true` to skip TTY prompts if needed) after adding `.npmrc`.

**Anti-fix:** `config.resolve.symlinks = false` in `next.config.mjs` actually made this **worse** (increased casing warnings) by preventing webpack from normalising resolved paths back through symlinks. Revert this if applied.

### Memgraph Cypher: always anchor to User node

Never query `Memory` directly:
```cypher
-- ❌ WRONG
MATCH (m:Memory {id: $memId})
-- ✅ CORRECT
MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memId})
```

### SKIP/LIMIT in Memgraph

Always use `toInteger()` or parameterised values via `wrapSkipLimit()`. Literal integers in SKIP/LIMIT fail in Memgraph.

### pnpm onlyBuiltDependencies

The `pnpm.onlyBuiltDependencies` field only takes effect at the **workspace root** `package.json`. Remove from individual package `package.json` files and consolidate at root.

---

## Known Pre-existing Issues (do not investigate)

- `tests/unit/entities/resolve.test.ts`: 3 failing unit tests — pre-existing, do not fix
- `app/api/v1/entities/[entityId]/route.ts`: TS2344 error on route params type — pre-existing Next.js 15 known issue, tracked upstream

---

## Session 2 — KuzuVectorStore Implementation & Benchmark

### Objective

Implement `KuzuVectorStore` for fully in-process/embedded vector storage (previously only `KuzuHistoryManager` existed), and benchmark KuzuDB vs Memgraph for insert + search latency.

### Files Changed

| File | Change |
|------|--------|
| `mem0-ts/src/oss/src/vector_stores/kuzu.ts` | **NEW** — `KuzuVectorStore` full implementation |
| `mem0-ts/src/oss/src/storage/kuzu.d.ts` | Fixed `getAll()` return type: `Promise<...>` (was incorrectly sync) |
| `mem0-ts/src/oss/src/storage/KuzuHistoryManager.ts` | Added `await` to `result.getAll()` (was missing) |
| `mem0-ts/src/oss/src/vector_stores/memgraph.ts` | Fixed `init()` DDL and `search()` `k` integer type |
| `mem0-ts/src/oss/src/utils/factory.ts` | Added `KuzuVectorStore` import + `"kuzu"` case |
| `mem0-ts/src/oss/src/index.ts` | Added `export * from "./vector_stores/kuzu"` |
| `mem0-ts/bench/benchmark.cjs` | Pure CJS comparative benchmark |

### KuzuDB 0.9.0 Critical Quirks (from runtime probing)

1. **`getAll()` is async** — `.d.ts` stub says sync; actual runtime returns `Promise<...>`. Always `await result.getAll()`.
2. **`FLOAT[n]` ≠ `FLOAT[]`** — `FLOAT[n]` is ARRAY type; `FLOAT[]` is LIST type. `array_cosine_similarity` requires both args to be LIST — use `FLOAT[]` in DDL.
3. **Parameterized query vector `$q` is rejected** — Memgraph-like `$q` params fail: "ARRAY_COSINE_SIMILARITY requires argument type to be FLOAT[] or DOUBLE[]" because KuzuDB can't infer type of JS array param as FLOAT[] LIST. Must inline the vector as float literals.
4. **`toInteger()` doesn't exist in KuzuDB Cypher** — parameterized LIMIT works fine though.

### KuzuVectorStore Implementation Pattern

```typescript
// DDL: FLOAT[] (LIST), not FLOAT[n] (ARRAY)
`CREATE NODE TABLE IF NOT EXISTS MemVector (
   id      STRING, vec  FLOAT[], payload STRING, PRIMARY KEY (id)
)`

// vecLiteral helper — required; $q param is rejected by similarity functions
private vecLiteral(v: number[]): string {
  return "[" + v.map((x) => x.toFixed(8)).join(",") + "]";
}

// search: MUST use conn.query() with inline literal, NOT prepared statement
const vecLit = this.vecLiteral(query);
const result = await this.conn.query(
  `MATCH (v:MemVector)
   WITH v, array_cosine_similarity(v.vec, ${vecLit}) AS score
   ORDER BY score DESC LIMIT ${fetchLimit}
   RETURN v.id AS id, v.payload AS payload, score`
);
const rows = await result.getAll();  // getAll() is async — must await
```

### Memgraph Fixes

- **Vector index DDL syntax**: `CREATE VECTOR INDEX name ON :Label(prop) WITH CONFIG {"dimension": N, "capacity": 100000, "metric": "cos"}` (NOT `OPTIONS {size:}`)
- **`k` must be explicit integer**: pass `neo4j.int(k)` to `vector_search.search()` — JS number fails with "must be of type INTEGER"

### Benchmark Results (dim=128, 200 inserts, 20×10 batch, 200 searches, k=10)

| Operation | KuzuDB (in-process) | Memgraph (TCP bolt, HNSW) | Winner |
|-----------|---------------------|---------------------------|--------|
| insert single mean | 0.47 ms | 0.88 ms | KuzuDB 1.9× |
| insert single p95 | 0.64 ms | 1.12 ms | KuzuDB |
| insert batch/10 mean | 0.45 ms | 0.92 ms | KuzuDB 2.0× |
| search k=10 mean | 5.47 ms | **0.86 ms** | **Memgraph 6.4×** |
| search k=10 p95 | 6.43 ms | 1.15 ms | Memgraph |
| search ops/s | 183 | 1165 | Memgraph |

**Key takeaways:**
- KuzuDB inserts are ~2× faster (no TCP roundtrip — in-process)
- Memgraph search is **6.4× faster** because it uses HNSW index (sub-linear), KuzuDB does brute-force linear scan
- As collection size grows, KuzuDB search degrades linearly while Memgraph HNSW stays O(log n)
- Use KuzuDB for small (< 10K vectors) fully-offline scenarios; use Memgraph for production/large collections

### Verification

- `pnpm exec tsc --noEmit`: **0 errors**
- KuzuDB benchmark ran successfully (dim=128, all three phases complete)
- Memgraph benchmark ran successfully (confirmed MAGE available in Docker container `loving_jennings`)

### Usage (KuzuVectorStore)

```typescript
const memory = new Memory({
  vectorStore: {
    provider: "kuzu",
    config: { dbPath: "./my_vectors", dimension: 1536, metric: "cos" },
  },
  historyStore: {
    provider: "kuzu",
    config: { dbPath: "./my_history" },
  },
});
```

---

## Session 3 — Full Pipeline Benchmark (add + search + graph)

### Objective

Benchmark the full `Memory.add()` + `Memory.search()` pipeline with both storage backends — not just raw vector ops but including the dedup search, the actual vector writes, and the history/graph writes. Also fixed a correctness bug in `KuzuVectorStore` where userId filtering was post-processed in JS over a full table scan.

### Files Changed

| File | Change |
|------|--------|
| `mem0-ts/bench/full-pipeline.cjs` | **NEW** — full pipeline benchmark (mock embed + mock LLM) |
| `mem0-ts/src/oss/src/vector_stores/kuzu.ts` | Added `user_id` column + Cypher pre-filter for multi-user correctness/perf |

### Full Pipeline Architecture (what `Memory.add()` actually does)

```
add():
  1. embed input          ← OpenAI ~80ms   (MOCKED in benchmark)
  2. llm.extractFacts     ← OpenAI ~600ms  (MOCKED)
  3. for each fact:
     a. embed fact        ← OpenAI ~80ms   (MOCKED)
     b. vectorSearch      ← REAL (dedup lookup, ×2 for 2 facts)
  4. llm.updateDecision   ← OpenAI ~600ms  (MOCKED)
  5. for each ADD/UPDATE action:
     a. vectorInsert      ← REAL
     b. historyWrite      ← REAL (graph write)

search():
  1. embed query          ← OpenAI ~80ms   (MOCKED)
  2. vectorSearch         ← REAL
```

### Full Pipeline Benchmark Results (dim=128, 150 adds, 150 searches, k=10)

**add() phase breakdown:**

| Phase | KuzuDB p50 | Memgraph p50 | Winner |
|-------|-----------|--------------|--------|
| vectorSearch (dedup ×2) | 8.89 ms | 2.34 ms | Memgraph **3.8×** |
| vectorInsert (per action) | 2.10 ms | 2.22 ms | KuzuDB **1.1×** ≈ tie |
| historyWrite (graph) | 1.52 ms | 1.82 ms | KuzuDB **1.2×** ≈ tie |
| **total add() [storage]** | **13.15 ms** | **8.44 ms** | **Memgraph 1.6×** |

**search() (storage only):**

| | KuzuDB | Memgraph | Winner |
|--|--------|----------|--------|
| p50 | 5.44 ms | 1.20 ms | Memgraph **4.5×** |
| p95 | 16.19 ms | 2.22 ms | Memgraph **7.3×** |

**Real-world projection (with actual OpenAI):**
- OpenAI subtotal: ~80ms embed + ~600ms extractFacts + ~600ms updateDecision = **~1,280ms**
- Total add() p50: KuzuDB ~1,293ms vs Memgraph ~1,288ms → **<1% difference**
- OpenAI dominates storage → backend choice doesn't change total add() latency significantly
- Total search() p50: KuzuDB ~85ms vs Memgraph ~81ms → 5% difference (embed dominates both)

**Key takeaway:** The biggest raw difference is in vectorSearch during dedup (Memgraph HNSW vs KuzuDB brute-force). With OpenAI in the loop, this difference becomes insignificant. **Choose backend for operational reasons** (persistence, graph queries, scalability) not raw latency.

### KuzuVectorStore Bug Fixed: userId pre-filtering

**Problem:** `KuzuVectorStore.search()` was doing a full table scan over ALL vectors (all users), then post-filtering in JS. On a multi-user collection this means:
- Results could be wrong (wrong user's vectors could dominate the top-k before filtering)  
- Performance degrades O(total_vectors), not O(vectors_for_this_user)

**Fix:** Added dedicated `user_id STRING` column to `MemVector` table. Cypher WHERE pre-filter runs before cosine computation:
```cypher
MATCH (v:MemVector)
WHERE v.user_id = 'alice'     -- ← now a real column, not JSON parse
WITH v, array_cosine_similarity(v.vec, [...]) AS score
ORDER BY score DESC LIMIT 10
```
Note: `JSON_EXTRACT()` doesn't exist in KuzuDB 0.9 (requires separate JSON extension install).

### KuzuDB quirk added: JSON_EXTRACT unavailable

Add to the existing KuzuDB quirks list:
5. `JSON_EXTRACT()` requires the JSON extension (`INSTALL JSON; LOAD EXTENSION JSON;`) — NOT available by default. Store filterable fields as dedicated columns instead.
