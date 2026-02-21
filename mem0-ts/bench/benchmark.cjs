/**
 * Benchmark: KuzuVectorStore vs MemgraphVectorStore
 * ===================================================
 * Pure CJS — no TypeScript, no ESM resolution quirks.
 * Run: node bench/benchmark.cjs
 */

"use strict";

const { performance } = require("perf_hooks");
const kuzu = require("kuzu");
const neo4j = require("neo4j-driver");
const path = require("path");
const { randomUUID } = require("crypto");

// ── Config ──────────────────────────────────────────────────────────────────
const DIM        = 128;
const WARMUP     = 10;
const INSERTS    = 200;
const BATCH_SIZE = 10;
const BATCH_OPS  = 50;
const SEARCHES   = 200;
const SEARCH_K   = 10;

const MEMGRAPH_URL  = process.env.MEMGRAPH_URL  ?? "bolt://127.0.0.1:7687";
const MEMGRAPH_USER = process.env.MEMGRAPH_USER ?? "memgraph";
const MEMGRAPH_PASS = process.env.MEMGRAPH_PASSWORD ?? "memgraph";

// ── Helpers ──────────────────────────────────────────────────────────────────
function randVec(dim) {
  const v = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const pct = p => sorted[Math.ceil((p / 100) * n) - 1];
  const mean = times.reduce((s, t) => s + t, 0) / n;
  return { mean, p50: pct(50), p95: pct(95), p99: pct(99), min: sorted[0], max: sorted[n - 1], ops: Math.round(1000 / mean) };
}

function row(label, times) {
  const s = stats(times);
  console.log(
    `  ${label.padEnd(20)} ` +
    `mean=${s.mean.toFixed(2).padStart(7)}ms  ` +
    `p50=${s.p50.toFixed(2).padStart(7)}ms  ` +
    `p95=${s.p95.toFixed(2).padStart(7)}ms  ` +
    `p99=${s.p99.toFixed(2).padStart(7)}ms  ` +
    `min=${s.min.toFixed(2).padStart(6)}ms  ` +
    `max=${s.max.toFixed(2).padStart(7)}ms  ` +
    `ops/s=${s.ops.toString().padStart(5)}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// KuzuDB store
// ══════════════════════════════════════════════════════════════════════════════
class KuzuStore {
  constructor() {
    this.db = new kuzu.Database();
    this.conn = new kuzu.Connection(this.db);
  }

  async init() {
    await this.conn.query(
      "CREATE NODE TABLE IF NOT EXISTS BenchVec(id STRING, vec FLOAT[], payload STRING, PRIMARY KEY(id))"
    );
    this.insertStmt = await this.conn.prepare(
      "MERGE (v:BenchVec {id:$id}) ON CREATE SET v.vec=$vec, v.payload=$payload ON MATCH SET v.vec=$vec, v.payload=$payload"
    );
  }

  async insert(vecs, ids, payloads) {
    for (let i = 0; i < ids.length; i++) {
      await this.conn.execute(this.insertStmt, { id: ids[i], vec: vecs[i], payload: JSON.stringify(payloads[i]) });
    }
  }

  async search(query, k) {
    const lit = "[" + query.map(x => x.toFixed(8)).join(",") + "]";
    const r = await this.conn.query(
      `MATCH (v:BenchVec) WITH v, array_cosine_similarity(v.vec, ${lit}) AS score ORDER BY score DESC LIMIT ${k} RETURN v.id AS id, score`
    );
    return await r.getAll();
  }

  async reset() {
    await this.conn.query("MATCH (v:BenchVec) DELETE v");
  }

  close() {
    // KuzuDB conn.close() / db.close() cause STATUS_ACCESS_VIOLATION (native crash)
    // on KuzuDB 0.9 when called explicitly. Let Node GC + process.exit(0) handle cleanup.
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Memgraph store (neo4j-driver bolt)
// ══════════════════════════════════════════════════════════════════════════════
class MemgraphStore {
  constructor() {
    this.driver = neo4j.driver(
      MEMGRAPH_URL,
      neo4j.auth.basic(MEMGRAPH_USER, MEMGRAPH_PASS),
      { disableLosslessIntegers: true }
    );
    this.indexName = "bench_bench_vectors";
    this.dimension = DIM;
  }

  async init() {
    const session = this.driver.session();
    try {
      await session.run(
        `CREATE VECTOR INDEX bench_bench_vectors ON :BenchVec(embedding) WITH CONFIG {"dimension": ${DIM}, "capacity": 100000, "metric": "cos"}`
      );
      console.log(" [vector index created]");
    } catch { /* already exists */ }

    // Pre-create one node to force index hydration
    try {
      await session.run(
        "MERGE (v:BenchVec {id: '__warmup__'}) SET v.embedding = $e, v.payload = '{}'",
        { e: Array(DIM).fill(0) }
      );
    } catch {}
    await session.close();
  }

  async insert(vecs, ids, payloads) {
    // UNWIND: one bolt round-trip per batch, regardless of batch size.
    // Mirrors the improvement made to MemgraphVectorStore.insert() in memgraph.ts.
    const rows = ids.map((id, i) => ({
      id,
      embedding: vecs[i],
      payload: JSON.stringify(payloads[i]),
    }));
    const session = this.driver.session();
    try {
      await session.run(
        `UNWIND $rows AS row
         MERGE (v:BenchVec {id: row.id})
         SET v.embedding = row.embedding, v.payload = row.payload`,
        { rows },
      );
    } finally {
      await session.close();
    }
  }

  async search(query, k) {
    const session = this.driver.session();
    try {
      const result = await session.run(
        "CALL vector_search.search($idx, $k, $query) YIELD node, similarity RETURN node.id AS id, similarity",
        { idx: this.indexName, k: neo4j.int(k), query }
      );
      return result.records.map(r => ({ id: r.get("id"), score: r.get("similarity") }));
    } finally {
      await session.close();
    }
  }

  async reset() {
    const session = this.driver.session();
    try {
      await session.run("MATCH (v:BenchVec) DETACH DELETE v");
    } finally {
      await session.close();
    }
  }

  async close() {
    await this.driver.close().catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Benchmark runner
// ══════════════════════════════════════════════════════════════════════════════
async function benchmarkStore(label, store) {
  console.log(`\n${"─".repeat(95)}`);
  console.log(`  ${label}  (dim=${DIM})`);
  console.log(`${"─".repeat(95)}`);

  await store.init();

  // warmup
  process.stdout.write("  [warmup] insert...");
  for (let i = 0; i < WARMUP; i++) {
    const id = randomUUID(); const vec = randVec(DIM);
    await store.insert([vec], [id], [{ user_id: "bench", memory: `w${i}` }]);
  }
  process.stdout.write(" search...");
  for (let i = 0; i < WARMUP; i++) await store.search(randVec(DIM), SEARCH_K);
  console.log(" done");

  // ── insert single ──
  process.stdout.write(`  [bench]  insert ${INSERTS}...`);
  const insertTimes = [];
  for (let i = 0; i < INSERTS; i++) {
    const id = randomUUID(); const vec = randVec(DIM); const payload = { user_id: "bench", memory: `insert ${i}` };
    const t0 = performance.now();
    await store.insert([vec], [id], [payload]);
    insertTimes.push(performance.now() - t0);
  }
  console.log(" done");

  // ── insert batch ──
  process.stdout.write(`  [bench]  batch-insert ${BATCH_OPS}×${BATCH_SIZE}...`);
  const batchTimes = [];
  for (let b = 0; b < BATCH_OPS; b++) {
    const ids = Array.from({ length: BATCH_SIZE }, () => randomUUID());
    const vecs = Array.from({ length: BATCH_SIZE }, () => randVec(DIM));
    const payloads = ids.map((_, i) => ({ user_id: "bench", memory: `batch ${b}-${i}` }));
    const t0 = performance.now();
    await store.insert(vecs, ids, payloads);
    batchTimes.push((performance.now() - t0) / BATCH_SIZE);
  }
  console.log(" done");

  // ── search ──
  process.stdout.write(`  [bench]  search ${SEARCHES}...`);
  const searchTimes = [];
  for (let i = 0; i < SEARCHES; i++) {
    const q = randVec(DIM);
    const t0 = performance.now();
    await store.search(q, SEARCH_K);
    searchTimes.push(performance.now() - t0);
  }
  console.log(" done\n");

  row(`insert (single)`, insertTimes);
  row(`insert (batch/${BATCH_SIZE})`, batchTimes);
  row(`search (k=${SEARCH_K})`, searchTimes);

  await store.reset();
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sep = "═".repeat(95);
  console.log(sep);
  console.log("  mem0 Vector Store Benchmark  —  KuzuDB vs Memgraph");
  console.log(`  dim=${DIM}  warmup=${WARMUP}  inserts=${INSERTS}  batch=${BATCH_SIZE}×${BATCH_OPS}  searches=${SEARCHES}  k=${SEARCH_K}`);
  console.log(sep);

  // ── KuzuDB ──
  const kuzuStore = new KuzuStore();
  await benchmarkStore("KuzuVectorStore  [in-process, FLOAT[] brute-force cosine]", kuzuStore);
  kuzuStore.close();

  // ── Memgraph ──
  let mgReachable = false;
  const testDriver = neo4j.driver(MEMGRAPH_URL, neo4j.auth.basic(MEMGRAPH_USER, MEMGRAPH_PASS), { disableLosslessIntegers: true });
  try {
    const ts = testDriver.session();
    await Promise.race([
      ts.run("RETURN 1").then(() => ts.close()),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))
    ]);
    mgReachable = true;
  } catch { mgReachable = false; }
  finally { await testDriver.close().catch(() => {}); }

  if (!mgReachable) {
    console.log("\n⚠  Memgraph not reachable at " + MEMGRAPH_URL);
  } else {
    const mgStore = new MemgraphStore();
    await benchmarkStore("MemgraphVectorStore  [TCP bolt, MAGE HNSW vector_search]", mgStore);
    await mgStore.close();
  }

  console.log("\n" + sep);
  console.log("  Benchmark complete.");
  console.log(sep + "\n");
  process.exit(0);
}

const _timeout = setTimeout(() => {
  console.error("\nTIMED OUT after 3 minutes");
  process.exit(1);
}, 180_000);

main()
  .then(() => { clearTimeout(_timeout); process.exit(0); })
  .catch(e => { console.error(e); clearTimeout(_timeout); process.exit(1); });
