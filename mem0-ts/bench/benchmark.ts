/**
 * Benchmark: KuzuVectorStore vs MemgraphVectorStore
 * ===================================================
 * Measures per-operation latency (ms) for:
 *   • insert      — single-record upserts, one at a time
 *   • batchInsert — 10 records inserted per call (measured as total / 10 per record)
 *   • search      — ANN / cosine search returning top-10
 *
 * Reports: mean, p50, p95, p99, min, max, throughput (ops/s)
 *
 * Run:
 *   npx tsx bench/benchmark.ts
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const kuzu = require("kuzu") as typeof import("kuzu");
import neo4j from "neo4j-driver";
import { performance } from "perf_hooks";
import { KuzuVectorStore } from "../src/oss/src/vector_stores/kuzu";
import { MemgraphVectorStore } from "../src/oss/src/vector_stores/memgraph";
import type { VectorStore } from "../src/oss/src/vector_stores/base";

// ── Config ──────────────────────────────────────────────────────────────────
const DIM = 128;          // embedding dimension (smaller = faster warmup, realistic shape)
const WARMUP = 10;        // ops run before measurement starts
const INSERTS = 200;      // individual insert measurements
const BATCH_SIZE = 10;    // records per batch-insert call
const BATCH_OPS = 50;     // number of batch calls to measure
const SEARCHES = 200;     // search measurements
const SEARCH_K = 10;      // top-K results requested

const MEMGRAPH_URL = process.env.MEMGRAPH_URL ?? "bolt://localhost:7687";
const MEMGRAPH_USER = process.env.MEMGRAPH_USER ?? "memgraph";
const MEMGRAPH_PASS = process.env.MEMGRAPH_PASSWORD ?? "memgraph";

// ── Helpers ──────────────────────────────────────────────────────────────────
function randVec(dim: number): number[] {
  const v = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function stats(times: number[]): {
  mean: number; p50: number; p95: number; p99: number;
  min: number; max: number; ops: number;
} {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const pct = (p: number) => sorted[Math.ceil((p / 100) * n) - 1];
  const mean = times.reduce((s, t) => s + t, 0) / n;
  return {
    mean,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    min: sorted[0],
    max: sorted[n - 1],
    ops: Math.round(1000 / mean),
  };
}

function printStats(label: string, times: number[]): void {
  const s = stats(times);
  console.log(
    `  ${label.padEnd(18)} ` +
    `mean=${s.mean.toFixed(2).padStart(7)}ms  ` +
    `p50=${s.p50.toFixed(2).padStart(7)}ms  ` +
    `p95=${s.p95.toFixed(2).padStart(7)}ms  ` +
    `p99=${s.p99.toFixed(2).padStart(7)}ms  ` +
    `min=${s.min.toFixed(2).padStart(6)}ms  ` +
    `max=${s.max.toFixed(2).padStart(7)}ms  ` +
    `ops/s=${s.ops.toString().padStart(5)}`,
  );
}

async function measureInsert(store: VectorStore, n: number): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    const vec = randVec(DIM);
    const payload = { user_id: "bench_user", memory: `memory ${i}`, index: i };
    const t0 = performance.now();
    await store.insert([vec], [id], [payload]);
    times.push(performance.now() - t0);
  }
  return times;
}

async function measureBatchInsert(
  store: VectorStore, batchSize: number, calls: number,
): Promise<number[]> {
  const perRecordTimes: number[] = [];
  for (let c = 0; c < calls; c++) {
    const ids = Array.from({ length: batchSize }, () => crypto.randomUUID());
    const vecs = Array.from({ length: batchSize }, () => randVec(DIM));
    const payloads = ids.map((_, i) => ({ user_id: "bench_user", memory: `batch ${c}-${i}` }));
    const t0 = performance.now();
    await store.insert(vecs, ids, payloads);
    const elapsed = performance.now() - t0;
    perRecordTimes.push(elapsed / batchSize); // per-record time
  }
  return perRecordTimes;
}

async function measureSearch(store: VectorStore, n: number): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const q = randVec(DIM);
    const t0 = performance.now();
    await store.search(q, SEARCH_K);
    times.push(performance.now() - t0);
  }
  return times;
}

// ── Connectivity probe for Memgraph ─────────────────────────────────────────
async function memgraphReachable(): Promise<boolean> {
  const driver = neo4j.driver(
    MEMGRAPH_URL,
    neo4j.auth.basic(MEMGRAPH_USER, MEMGRAPH_PASS),
    { disableLosslessIntegers: true },
  );
  // Set a 4-second deadline using a race
  const probe = async () => {
    const s = driver.session();
    await s.run("RETURN 1");
    await s.close();
  };
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), 4000),
  );
  try {
    await Promise.race([probe(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    await driver.close().catch(() => {/* ignore */});
  }
}

// ── Benchmark one store ───────────────────────────────────────────────────────
async function benchmarkStore(name: string, store: VectorStore): Promise<void> {
  console.log(`\n${"─".repeat(90)}`);
  console.log(`  ${name}  (dim=${DIM}, inserts=${INSERTS}, batch=${BATCH_SIZE}×${BATCH_OPS}, searches=${SEARCHES})`);
  console.log(`${"─".repeat(90)}`);

  await store.initialize();

  // warm up
  process.stdout.write("  [warmup] insert...");
  await measureInsert(store, WARMUP);
  process.stdout.write(` search...`);
  await measureSearch(store, WARMUP);
  console.log(" done");

  // insert (single)
  process.stdout.write(`  [bench]  insert ${INSERTS}...`);
  const insertTimes = await measureInsert(store, INSERTS);
  console.log(" done");

  // batch insert
  process.stdout.write(`  [bench]  batch-insert ${BATCH_OPS}×${BATCH_SIZE}...`);
  const batchTimes = await measureBatchInsert(store, BATCH_SIZE, BATCH_OPS);
  console.log(" done");

  // search
  process.stdout.write(`  [bench]  search ${SEARCHES}...`);
  const searchTimes = await measureSearch(store, SEARCHES);
  console.log(" done\n");

  printStats("insert (single)", insertTimes);
  printStats(`insert (batch/${BATCH_SIZE})`, batchTimes);
  printStats(`search (k=${SEARCH_K})`, searchTimes);

  // cleanup
  await store.reset?.();
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log("═".repeat(90));
  console.log("  mem0 Vector Store Benchmark");
  console.log(`  dim=${DIM}  warmup=${WARMUP}  inserts=${INSERTS}  searches=${SEARCHES}`);
  console.log("═".repeat(90));

  // ── KuzuDB (in-memory) ──
  const kuzuStore = new KuzuVectorStore({
    dbPath: ":memory:",
    dimension: DIM,
    metric: "cos",
  });
  await benchmarkStore("KuzuVectorStore  (in-memory, brute-force cosine)", kuzuStore);
  (kuzuStore as any).close?.();

  // ── Memgraph ──
  const reachable = await memgraphReachable();
  if (!reachable) {
    console.log("\n⚠  Memgraph not reachable at", MEMGRAPH_URL, "— skipping Memgraph benchmark.");
    console.log("   Start it with: docker run -p 7687:7687 memgraph/memgraph-mage");
  } else {
    const mgStore = new MemgraphVectorStore({
      url: MEMGRAPH_URL,
      username: MEMGRAPH_USER,
      password: MEMGRAPH_PASS,
      dimension: DIM,
      metric: "cos",
      collectionName: "bench_vectors",
    });
    await benchmarkStore("MemgraphVectorStore (TCP bolt, HNSW vector index)", mgStore);
    (mgStore as any).close?.();
  }

  console.log("\n" + "═".repeat(90));
  console.log("  Benchmark complete.");
  console.log("═".repeat(90) + "\n");
  process.exit(0);
})();
