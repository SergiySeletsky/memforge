/**
 * Full Pipeline Benchmark: KuzuDB vs Memgraph
 * =============================================
 * Replicates the real Memory.add() + Memory.search() pipeline:
 *   add():    [embed] → [llm:extractFacts] → [vectorSearch dedup] → [llm:updateDecision] → [vectorInsert] → [historyWrite]
 *   search(): [embed] → [vectorSearch]
 *
 * Embedder and LLM are MOCKED (return instantly, zero latency) so this
 * isolates the graph + vector storage layer differences between backends.
 * At the end we show how real OpenAI p50 latencies (embed ~80ms, LLM ~600ms+600ms)
 * would affect total wall-clock time.
 *
 * Run: node bench/full-pipeline.cjs
 */

"use strict";

const { performance } = require("perf_hooks");
const kuzu = require("kuzu");
const neo4j = require("neo4j-driver");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const os = require("os");
const fs = require("fs");

// ── Config ──────────────────────────────────────────────────────────────────
const DIM        = 128;
const WARMUP     = 10;
const ADD_OPS    = 150;   // add() operations
const SEARCH_OPS = 150;   // search() operations
const SEARCH_K   = 10;

// Realistic p50 latencies from OpenAI (informational, not benchmarked here)
const OPENAI_EMBED_P50_MS   = 80;
const OPENAI_LLM_P50_MS     = 600;  // per LLM call (×2 per add: extractFacts + updateDecision)

// ── Mock helpers ─────────────────────────────────────────────────────────────
function randVec(dim = DIM) {
  const v = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / n);
}

// Mock embed: pre-generate fixed random vectors, return instantly
const FACT_VECS = Array.from({ length: 20 }, () => randVec());
let _factIdx = 0;
function mockEmbed() { return FACT_VECS[_factIdx++ % FACT_VECS.length]; }

// Mock LLM extractFacts: returns 2 predetermined facts instantly
function mockExtractFacts() {
  return [
    "User loves specialty coffee and pour-over brewing",
    "User is a software engineer who prefers TypeScript",
  ];
}

// Mock LLM updateDecision: decide to ADD both facts (no existing to conflict with initially)
function mockUpdateDecision(existingCount) {
  // If no existing memories, ADD both facts
  // If some exist, UPDATE the first one (to exercise update code path too)
  if (existingCount === 0) {
    return [
      { event: "ADD",    text: "User loves specialty coffee and pour-over brewing" },
      { event: "ADD",    text: "User is a software engineer who prefers TypeScript" },
    ];
  }
  return [
    { event: "UPDATE", id: "0", text: "User loves specialty coffee and pour-over brewing (updated)" },
    { event: "ADD",    text: "User is a software engineer who prefers TypeScript" },
  ];
}

// ── Stats ────────────────────────────────────────────────────────────────────
function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const pct = p => sorted[Math.max(0, Math.ceil((p / 100) * n) - 1)];
  const mean = times.reduce((s, t) => s + t, 0) / n;
  return { mean, p50: pct(50), p95: pct(95), p99: pct(99), min: sorted[0], max: sorted[n - 1], ops: Math.round(1000 / mean) };
}

function fms(n) { return n.toFixed(2).padStart(7) + "ms"; }
function fops(n) { return n.toString().padStart(5); }

function printRow(label, times, padLabel = 28) {
  const s = stats(times);
  console.log(
    "  " + label.padEnd(padLabel) +
    `mean=${fms(s.mean)}  p50=${fms(s.p50)}  p95=${fms(s.p95)}  p99=${fms(s.p99)}` +
    `  min=${fms(s.min)}  max=${fms(s.max)}  ops/s=${fops(s.ops)}`
  );
}

function printComparison(label, kuzuTimes, mgTimes, padLabel = 28) {
  const k = stats(kuzuTimes);
  const m = stats(mgTimes);
  const winner = k.p50 < m.p50 ? `KuzuDB ${(m.p50/k.p50).toFixed(1)}×` : `Memgraph ${(k.p50/m.p50).toFixed(1)}×`;
  console.log(
    "  " + label.padEnd(padLabel) +
    `KuzuDB p50=${fms(k.p50)}  Memgraph p50=${fms(m.p50)}    → ${winner}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  KuzuDB Backend
// ─────────────────────────────────────────────────────────────────────────────

class KuzuBackend {
  constructor() {
    const tmpDir = path.join(os.tmpdir(), `kbench_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    this.tmpDir = tmpDir;
    this.db = new kuzu.Database(path.join(tmpDir, "vec"));
    this.conn = new kuzu.Connection(this.db);

    this.histDb = new kuzu.Database(path.join(tmpDir, "hist"));
    this.histConn = new kuzu.Connection(this.histDb);
  }

  get name() { return "KuzuDB (in-process)"; }
  get tag()  { return "kuzu"; }

  async init() {
    await this.conn.query(`
      CREATE NODE TABLE IF NOT EXISTS MemVector (
        id      STRING,
        user_id STRING,
        vec     FLOAT[],
        payload STRING,
        PRIMARY KEY (id)
      )
    `);
    await this.histConn.query(`
      CREATE NODE TABLE IF NOT EXISTS MemoryHistory (
        id             STRING,
        memory_id      STRING,
        previous_value STRING,
        new_value      STRING,
        action         STRING,
        created_at     STRING,
        updated_at     STRING,
        is_deleted     INT64,
        PRIMARY KEY (id)
      )
    `);
  }

  async vectorInsert(id, vec, payload) {
    const stmt = await this.conn.prepare(
      `MERGE (v:MemVector {id: $id})
       ON CREATE SET v.user_id = $uid, v.vec = $vec, v.payload = $payload
       ON MATCH  SET v.user_id = $uid, v.vec = $vec, v.payload = $payload`
    );
    await this.conn.execute(stmt, { id, uid: payload.userId ?? "", vec, payload: JSON.stringify(payload) });
  }

  async vectorSearch(queryVec, k, userId) {
    // CAST($vec AS FLOAT[DIM]) coerces the LIST param to a typed ARRAY so
    // array_cosine_similarity accepts it — no inline float literals needed.
    // KuzuDB 0.9 bug: integer $params + CAST crash — inline LIMIT as a literal.
    const stmt = await this.conn.prepare(
      `MATCH (v:MemVector)
       WHERE v.user_id = $uid
       WITH v, array_cosine_similarity(v.vec, CAST($vec AS FLOAT[${DIM}])) AS score
       ORDER BY score DESC LIMIT ${k * 4}
       RETURN v.id AS id, v.payload AS payload, score`
    );
    const r = await this.conn.execute(stmt, { vec: queryVec, uid: userId });
    return (await r.getAll()).map(row => ({
      id: row.id,
      payload: JSON.parse(row.payload),
      score: row.score
    }));
  }

  async vectorGet(id) {
    const stmt = await this.conn.prepare(
      `MATCH (v:MemVector {id: $id}) RETURN v.id AS id, v.payload AS payload`
    );
    const r = await this.conn.execute(stmt, { id });
    const rows = await r.getAll();
    if (!rows.length) return null;
    return { id: rows[0].id, payload: JSON.parse(rows[0].payload) };
  }

  async vectorUpdate(id, vec, payload) {
    const stmt = await this.conn.prepare(
      `MATCH (v:MemVector {id: $id}) SET v.user_id = $uid, v.vec = $vec, v.payload = $payload`
    );
    await this.conn.execute(stmt, { id, uid: payload.userId ?? "", vec, payload: JSON.stringify(payload) });
  }

  async historyWrite(memoryId, previousValue, newValue, action) {
    const stmt = await this.histConn.prepare(
      `CREATE (:MemoryHistory {
         id: $id, memory_id: $memory_id,
         previous_value: $previous_value, new_value: $new_value,
         action: $action, created_at: $created_at, updated_at: $updated_at,
         is_deleted: $is_deleted
       })`
    );
    await this.histConn.execute(stmt, {
      id: randomUUID(),
      memory_id: memoryId,
      previous_value: previousValue ?? "",
      new_value: newValue ?? "",
      action,
      created_at: new Date().toISOString(),
      updated_at: "",
      is_deleted: 0,
    });
  }

  async close() {
    // KuzuDB closes with GC
    try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Memgraph Backend
// ─────────────────────────────────────────────────────────────────────────────

class MemgraphBackend {
  constructor() {
    this.driver = neo4j.driver(
      "bolt://127.0.0.1:7687",
      neo4j.auth.basic("memgraph", "memgraph"),
      { disableLosslessIntegers: true }
    );
    this.vecIdx = `bench_full_${Date.now()}`;
  }

  get name() { return "Memgraph (TCP bolt, HNSW)"; }
  get tag()  { return "memgraph"; }

  newSession() { return this.driver.session(); }

  async run(cypher, params = {}) {
    const s = this.newSession();
    try     { return await s.run(cypher, params); }
    finally { await s.close(); }
  }

  async init() {
    // Clean slate
    await this.run("MATCH (v:BFullVec)  DETACH DELETE v");
    await this.run("MATCH (h:BFullHist) DETACH DELETE h");
    try { await this.run(`DROP VECTOR INDEX ${this.vecIdx}`); } catch {}
    await this.run(
      `CREATE VECTOR INDEX ${this.vecIdx} ON :BFullVec(embedding)
       WITH CONFIG {"dimension": ${DIM}, "capacity": 100000, "metric": "cos"}`
    );
  }

  async vectorInsert(id, vec, payload) {
    await this.run(
      `MERGE (v:BFullVec {id: $id}) SET v.embedding = $emb, v.payload = $p`,
      { id, emb: vec, p: JSON.stringify(payload) }
    );
  }

  async vectorSearch(queryVec, k, _userId) {
    const r = await this.run(
      `CALL vector_search.search($idx, $k, $query) YIELD node, similarity
       RETURN node.id AS id, node.payload AS payload, similarity AS score`,
      { idx: this.vecIdx, k: neo4j.int(k * 4), query: queryVec }
    );
    return r.records.map(rec => ({
      id: rec.get("id"),
      payload: JSON.parse(rec.get("payload")),
      score: rec.get("score"),
    }));
  }

  async vectorGet(id) {
    const r = await this.run(
      `MATCH (v:BFullVec {id: $id}) RETURN v.id AS id, v.payload AS payload`,
      { id }
    );
    if (!r.records.length) return null;
    return { id: r.records[0].get("id"), payload: JSON.parse(r.records[0].get("payload")) };
  }

  async vectorUpdate(id, vec, payload) {
    await this.run(
      `MATCH (v:BFullVec {id: $id}) SET v.embedding = $emb, v.payload = $p`,
      { id, emb: vec, p: JSON.stringify(payload) }
    );
  }

  async historyWrite(memoryId, previousValue, newValue, action) {
    await this.run(
      `MERGE (h:BFullHist {id: $id})
       SET h.memory_id = $mid, h.previous_value = $prev,
           h.new_value = $nv, h.action = $action,
           h.created_at = $ts, h.is_deleted = false`,
      {
        id: randomUUID(),
        mid: memoryId,
        prev: previousValue ?? "",
        nv: newValue ?? "",
        action,
        ts: new Date().toISOString(),
      }
    );
  }

  async close() {
    await this.run("MATCH (v:BFullVec)  DETACH DELETE v");
    await this.run("MATCH (h:BFullHist) DETACH DELETE h");
    try { await this.run(`DROP VECTOR INDEX ${this.vecIdx}`); } catch {}
    await this.driver.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pipeline simulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate Memory.add() with per-phase timing.
 * Returns { t_vectorSearch, t_vectorInsert, t_historyWrite, t_total }
 */
async function simulateAdd(backend, userId, roundNum) {
  const t0_total = performance.now();

  // ── Phase 1: embed input (MOCKED — would be ~80ms with OpenAI) ──
  const inputVec = mockEmbed();

  // ── Phase 2: LLM extractFacts (MOCKED — would be ~600ms with OpenAI) ──
  const facts = mockExtractFacts();

  // ── Phase 3: embed facts + vectorSearch for dedup ──
  const factEmbeddings = {};
  const existingMemories = [];
  let t_vectorSearch = 0;

  for (const fact of facts) {
    factEmbeddings[fact] = mockEmbed();
    const t0 = performance.now();
    const results = await backend.vectorSearch(factEmbeddings[fact], 5, userId);
    t_vectorSearch += performance.now() - t0;
    for (const r of results) existingMemories.push({ id: r.id, text: r.payload.data });
  }

  // ── Phase 4: LLM updateDecision (MOCKED — would be ~600ms with OpenAI) ──
  //    Build a UUID mapping like the real pipeline
  const uniqueExisting = existingMemories.filter(
    (m, i) => existingMemories.findIndex(x => x.id === m.id) === i
  );
  const tempUuidMap = {};
  uniqueExisting.forEach((item, idx) => { tempUuidMap[String(idx)] = item.id; });

  const actions = mockUpdateDecision(uniqueExisting.length);

  // ── Phases 5+6: vectorInsert + historyWrite for each action ──
  let t_vectorInsert = 0;
  let t_historyWrite = 0;

  for (const action of actions) {
    if (action.event === "ADD") {
      const memId = randomUUID();
      const embedding = factEmbeddings[action.text] || mockEmbed();
      const payload = {
        data: action.text,
        userId,
        hash: createHash("md5").update(action.text).digest("hex"),
        createdAt: new Date().toISOString(),
      };

      const t1 = performance.now();
      await backend.vectorInsert(memId, embedding, payload);
      t_vectorInsert += performance.now() - t1;

      const t2 = performance.now();
      await backend.historyWrite(memId, null, action.text, "ADD");
      t_historyWrite += performance.now() - t2;

    } else if (action.event === "UPDATE") {
      const realId = tempUuidMap[action.id];
      if (!realId) continue;

      const existing = await backend.vectorGet(realId);
      if (!existing) continue;

      const embedding = factEmbeddings[action.text] || mockEmbed();
      const newPayload = {
        ...existing.payload,
        data: action.text,
        hash: createHash("md5").update(action.text).digest("hex"),
        updatedAt: new Date().toISOString(),
      };

      const t1 = performance.now();
      await backend.vectorUpdate(realId, embedding, newPayload);
      t_vectorInsert += performance.now() - t1;

      const t2 = performance.now();
      await backend.historyWrite(realId, existing.payload.data, action.text, "UPDATE");
      t_historyWrite += performance.now() - t2;
    }
  }

  const t_total = performance.now() - t0_total;
  return { t_vectorSearch, t_vectorInsert, t_historyWrite, t_total };
}

/**
 * Simulate Memory.search() — embed + vectorSearch.
 * Returns { t_embed, t_vectorSearch, t_total }
 */
async function simulateSearch(backend, userId) {
  const t0 = performance.now();
  const queryVec = mockEmbed();                       // (MOCKED — ~80ms with OpenAI)
  const t1 = performance.now();
  await backend.vectorSearch(queryVec, SEARCH_K, userId);
  const t2 = performance.now();
  return { t_embed: t1 - t0, t_vectorSearch: t2 - t1, t_total: t2 - t0 };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Benchmark runner
// ─────────────────────────────────────────────────────────────────────────────

async function runBackend(backend) {
  console.log(`\n  Initializing ${backend.name}...`);
  await backend.init();

  const userId = `bench_user_${Date.now()}`;
  const phases = {
    vectorSearch: [], vectorInsert: [], historyWrite: [], totalAdd: [], totalSearch: [],
  };

  // ── Warmup ──
  process.stdout.write(`  Warmup (${WARMUP} ops)...`);
  for (let i = 0; i < WARMUP; i++) await simulateAdd(backend, userId, i);
  for (let i = 0; i < WARMUP; i++) await simulateSearch(backend, userId);
  console.log(" done");

  // ── add() benchmark ──
  process.stdout.write(`  add() ×${ADD_OPS}...`);
  for (let i = 0; i < ADD_OPS; i++) {
    const r = await simulateAdd(backend, userId, i);
    phases.vectorSearch.push(r.t_vectorSearch);
    phases.vectorInsert.push(r.t_vectorInsert);
    phases.historyWrite.push(r.t_historyWrite);
    phases.totalAdd.push(r.t_total);
  }
  console.log(" done");

  // ── search() benchmark ──
  process.stdout.write(`  search() ×${SEARCH_OPS}...`);
  for (let i = 0; i < SEARCH_OPS; i++) {
    const r = await simulateSearch(backend, userId);
    phases.totalSearch.push(r.t_total);
  }
  console.log(" done");

  await backend.close();
  return phases;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║     Full Memory Pipeline Benchmark: KuzuDB vs Memgraph              ║");
  console.log("║     Embed + LLM MOCKED (0 ms) — measures pure storage overhead      ║");
  console.log(`║     dim=${DIM}  add×${ADD_OPS}  search×${SEARCH_OPS}  k=${SEARCH_K}  warmup=${WARMUP}` + " ".repeat(Math.max(0, 39 - String(DIM+ADD_OPS+SEARCH_OPS+SEARCH_K+WARMUP).length)) + "║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  const kuzuBackend = new KuzuBackend();
  const mgBackend   = new MemgraphBackend();

  console.log("▸ KuzuDB backend");
  const kuzuPhases = await runBackend(kuzuBackend);

  console.log("\n▸ Memgraph backend");
  const mgPhases = await runBackend(mgBackend);

  // ── Results ──
  console.log("\n\n══════════════════════════════════════════════════════════════════════");
  console.log("  RESULTS — add() phase breakdown");
  console.log("══════════════════════════════════════════════════════════════════════\n");

  console.log("  KuzuDB:");
  printRow("vectorSearch (dedup ×2)",  kuzuPhases.vectorSearch);
  printRow("vectorInsert (×acts)",     kuzuPhases.vectorInsert);
  printRow("historyWrite (graph)",     kuzuPhases.historyWrite);
  printRow("total add() [storage]",    kuzuPhases.totalAdd);

  console.log("\n  Memgraph:");
  printRow("vectorSearch (dedup ×2)",  mgPhases.vectorSearch);
  printRow("vectorInsert (×acts)",     mgPhases.vectorInsert);
  printRow("historyWrite (graph)",     mgPhases.historyWrite);
  printRow("total add() [storage]",    mgPhases.totalAdd);

  console.log("\n\n══════════════════════════════════════════════════════════════════════");
  console.log("  RESULTS — search()");
  console.log("══════════════════════════════════════════════════════════════════════\n");

  console.log("  KuzuDB:");
  printRow("total search() [storage]", kuzuPhases.totalSearch);
  console.log("\n  Memgraph:");
  printRow("total search() [storage]", mgPhases.totalSearch);

  console.log("\n\n══════════════════════════════════════════════════════════════════════");
  console.log("  HEAD-TO-HEAD COMPARISON  (p50)");
  console.log("══════════════════════════════════════════════════════════════════════\n");

  printComparison("vectorSearch / dedup",  kuzuPhases.vectorSearch, mgPhases.vectorSearch);
  printComparison("vectorInsert",          kuzuPhases.vectorInsert, mgPhases.vectorInsert);
  printComparison("historyWrite (graph)",  kuzuPhases.historyWrite, mgPhases.historyWrite);
  printComparison("total add() storage",   kuzuPhases.totalAdd,     mgPhases.totalAdd);
  printComparison("total search() storage",kuzuPhases.totalSearch,  mgPhases.totalSearch);

  // ── Real-world projection ──
  const kAddP50  = stats(kuzuPhases.totalAdd).p50;
  const mgAddP50 = stats(mgPhases.totalAdd).p50;
  const kSrchP50 = stats(kuzuPhases.totalSearch).p50;
  const mgSrchP50= stats(mgPhases.totalSearch).p50;
  const llmTotal  = OPENAI_LLM_P50_MS * 2;  // extractFacts + updateDecision

  console.log("\n\n══════════════════════════════════════════════════════════════════════");
  console.log("  REAL-WORLD PROJECTION  (add p50 estimate with actual OpenAI APIs)");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`\n  Typical OpenAI latencies:`);
  console.log(`    embed (1 call)         ~${OPENAI_EMBED_P50_MS} ms`);
  console.log(`    llm extractFacts       ~${OPENAI_LLM_P50_MS} ms`);
  console.log(`    llm updateDecision     ~${OPENAI_LLM_P50_MS} ms`);
  console.log(`    ─────────────────────────────`);
  console.log(`    OpenAI subtotal        ~${OPENAI_EMBED_P50_MS + llmTotal} ms`);
  console.log(`\n  Total add() p50 estimate:`);
  console.log(`    KuzuDB  : ${(kAddP50).toFixed(1)} ms storage + ${OPENAI_EMBED_P50_MS + llmTotal} ms OpenAI = ~${Math.round(kAddP50 + OPENAI_EMBED_P50_MS + llmTotal)} ms`);
  console.log(`    Memgraph: ${(mgAddP50).toFixed(1)} ms storage + ${OPENAI_EMBED_P50_MS + llmTotal} ms OpenAI = ~${Math.round(mgAddP50 + OPENAI_EMBED_P50_MS + llmTotal)} ms`);
  console.log(`    OpenAI dominates — storage share: KuzuDB ${Math.round(100*kAddP50/(kAddP50+OPENAI_EMBED_P50_MS+llmTotal))}%  Memgraph ${Math.round(100*mgAddP50/(mgAddP50+OPENAI_EMBED_P50_MS+llmTotal))}%`);

  console.log(`\n  Total search() p50 estimate (embed only, no LLM):`);
  console.log(`    KuzuDB  : ${(kSrchP50).toFixed(1)} ms storage + ${OPENAI_EMBED_P50_MS} ms embed = ~${Math.round(kSrchP50 + OPENAI_EMBED_P50_MS)} ms`);
  console.log(`    Memgraph: ${(mgSrchP50).toFixed(1)} ms storage + ${OPENAI_EMBED_P50_MS} ms embed = ~${Math.round(mgSrchP50 + OPENAI_EMBED_P50_MS)} ms`);

  console.log("\n");
}

const to = setTimeout(() => { console.error("\nTIMED OUT after 3 minutes"); process.exit(1); }, 180000);
main()
  .then(() => { clearTimeout(to); process.exit(0); })
  .catch(e => { console.error("\n" + e.stack); clearTimeout(to); process.exit(1); });
