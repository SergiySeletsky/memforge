// eslint-disable-next-line @typescript-eslint/no-require-imports
const kuzu = require("kuzu") as typeof import("kuzu");
import path from "path";
import { VectorStore } from "./base";
import { SearchFilters, VectorStoreConfig, VectorStoreResult } from "../types";

/**
 * KuzuDB-backed vector store (KuzuDB 0.9+).
 *
 * ── Storage ──────────────────────────────────────────────────────────────────
 * Embeddings are stored as `FLOAT[]` LIST columns in an embedded KuzuDB
 * database.  All data lives in a single `MemVector` node table.
 * A dedicated `user_id` column enables Cypher-level pre-filtering to avoid
 * scanning other users' vectors before computing cosine.
 *
 * ── Similarity search ────────────────────────────────────────────────────────
 * KuzuDB 0.9 does NOT support ANN indexes — search is a full table scan with
 * `array_cosine_similarity` / `array_distance`.  For large collections (>100k
 * vectors) swap to Memgraph or Qdrant.
 *
 * ── KuzuDB quirks (all accounted for) ────────────────────────────────────────
 * 1. `getAll()` returns a `Promise` in the native addon despite the type stub
 *    showing a synchronous signature — always `await` it.
 * 2. Passing a plain JS array as `$vec` to similarity functions is rejected:
 *    "ARRAY_COSINE_SIMILARITY requires at least one argument to be ARRAY".
 *    Fix: `CAST($vec AS FLOAT[{dim}])` coerces the LIST parameter to the
 *    dimensioned ARRAY type — inspired by graphiti's implementation.
 * 3. `FLOAT[n]` (ARRAY) ≠ `FLOAT[]` (LIST).  We store as `FLOAT[]` LIST and
 *    use `CAST($vec AS FLOAT[dim])` on the query side; KuzuDB accepts the
 *    mixed operation when at least one operand is a typed ARRAY.
 * 4. `conn.query(sql, params)` — the second arg is a progress callback, NOT
 *    query params.  Always use `conn.prepare()` + `conn.execute(stmt, params)`.
 * 5. `JSON_EXTRACT()` requires the JSON extension (`INSTALL JSON; LOAD JSON`).
 *    Use dedicated columns for filterable fields instead of JSON payloads.
 * 6. `AsyncConnection` does not exist in the Node.js KuzuDB 0.9 bindings
 *    (Python-only).  Regular `Connection` with async/await is correct.
 * 7. KuzuDB 0.9 bug — mixing an integer `$param` with any `CAST(...)` expression
 *    in the same prepared statement causes a native crash (STATUS_ACCESS_VIOLATION
 *    / segfault).  Workaround: inline any integer values as literals and keep
 *    only typed parameters (`$uid` string, `$vec` float list) in the statement.
 *    Because of this, LIMIT must be a literal, so `search()` re-prepares each
 *    call.  The prepare overhead is negligible vs the O(n) scan cost.
 *
 * Usage:
 * ```ts
 * const memory = new Memory({
 *   vectorStore: {
 *     provider: "kuzu",
 *     config: { dbPath: "./my_vectors", dimension: 1536, metric: "cos" },
 *   },
 * });
 * ```
 */

interface KuzuVectorStoreConfig extends VectorStoreConfig {
  /** Path to the KuzuDB database directory.
   *  Omit or pass ":memory:" for an in-process transient store. */
  dbPath?: string;
  /** Vector similarity metric:
   *  - "cos" (default) — cosine similarity (higher = more similar)
   *  - "l2"            — Euclidean distance converted to score 1/(1+dist) */
  metric?: "cos" | "l2";
}

export class KuzuVectorStore implements VectorStore {
  private db: InstanceType<(typeof kuzu)["Database"]>;
  private conn: InstanceType<(typeof kuzu)["Connection"]>;
  private dimension: number;
  private metric: "cos" | "l2";
  private userId = "";
  private initialized: Promise<void>;

  constructor(config: KuzuVectorStoreConfig = {}) {
    this.dimension = config.dimension ?? 1536;
    this.metric = config.metric ?? "cos";

    const raw = config.dbPath;
    this.db =
      raw && raw !== ":memory:"
        ? new kuzu.Database(path.resolve(raw))
        : new kuzu.Database();
    this.conn = new kuzu.Connection(this.db);
    this.initialized = this.init();
  }

  // ---------------------------------------------------------------------------
  // Schema bootstrap
  // ---------------------------------------------------------------------------

  private async init(): Promise<void> {
    // FLOAT[] = dynamic LIST type — required so CAST($vec AS FLOAT[dim]) resolves.
    // user_id is a dedicated column so WHERE pre-filtering avoids a full cosine
    // scan on multi-user collections (JSON_EXTRACT is not available by default).
    await this.conn.query(
      `CREATE NODE TABLE IF NOT EXISTS MemVector (
         id      STRING,
         user_id STRING,
         vec     FLOAT[],
         payload STRING,
         PRIMARY KEY (id)
       )`,
    );
  }

  async initialize(): Promise<void> {
    await this.initialized;
  }

  // ---------------------------------------------------------------------------
  // VectorStore interface
  // ---------------------------------------------------------------------------

  async insert(
    vectors: number[][],
    ids: string[],
    payloads: Record<string, any>[],
  ): Promise<void> {
    await this.initialized;
    const stmt = await this.conn.prepare(
      `MERGE (v:MemVector {id: $id})
       ON CREATE SET v.user_id = $uid, v.vec = $vec, v.payload = $payload
       ON MATCH  SET v.user_id = $uid, v.vec = $vec, v.payload = $payload`,
    );
    for (let i = 0; i < ids.length; i++) {
      await this.conn.execute(stmt, {
        id: ids[i],
        uid: (payloads[i].userId as string) ?? "",
        vec: vectors[i],
        payload: JSON.stringify(payloads[i]),
      });
    }
  }

  async search(
    query: number[],
    limit = 10,
    filters?: SearchFilters,
    minScore = 0,
  ): Promise<VectorStoreResult[]> {
    await this.initialized;

    const userId = filters?.userId ? String(filters.userId) : null;
    // Over-fetch when additional (non-userId) filters require JS post-filtering.
    const hasExtraFilters = filters && Object.keys(filters).some((k) => k !== "userId");
    const fetchLimit = hasExtraFilters ? limit * 4 : limit;
    // KuzuDB quirk #7: integer params + CAST crashes (see class doc).
    // Inline LIMIT as a literal; keep $uid (string) and $vec (list) as params.
    const cast = `CAST($vec AS FLOAT[${this.dimension}])`;
    let rows: { id: string; payload: string; score: number }[];

    if (userId !== null) {
      const stmt = await this.conn.prepare(
        this.metric === "cos"
          ? `MATCH (v:MemVector)
             WHERE v.user_id = $uid
             WITH v, array_cosine_similarity(v.vec, ${cast}) AS score
             ORDER BY score DESC LIMIT ${fetchLimit}
             RETURN v.id AS id, v.payload AS payload, score`
          : `MATCH (v:MemVector)
             WHERE v.user_id = $uid
             WITH v, array_distance(v.vec, ${cast}) AS dist
             ORDER BY dist ASC LIMIT ${fetchLimit}
             RETURN v.id AS id, v.payload AS payload, (1.0 / (1.0 + dist)) AS score`,
      );
      const result = await this.conn.execute(stmt, { vec: query, uid: userId });
      rows = (await result.getAll()) as { id: string; payload: string; score: number }[];
    } else {
      const stmt = await this.conn.prepare(
        this.metric === "cos"
          ? `MATCH (v:MemVector)
             WITH v, array_cosine_similarity(v.vec, ${cast}) AS score
             ORDER BY score DESC LIMIT ${fetchLimit}
             RETURN v.id AS id, v.payload AS payload, score`
          : `MATCH (v:MemVector)
             WITH v, array_distance(v.vec, ${cast}) AS dist
             ORDER BY dist ASC LIMIT ${fetchLimit}
             RETURN v.id AS id, v.payload AS payload, (1.0 / (1.0 + dist)) AS score`,
      );
      const result = await this.conn.execute(stmt, { vec: query });
      rows = (await result.getAll()) as { id: string; payload: string; score: number }[];
    }

    return rows
      .map((r) => ({
        id: r.id,
        payload: JSON.parse(r.payload),
        score: r.score,
      }))
      .filter((r) => r.score >= minScore && this.matchesFilters(r.payload, filters))
      .slice(0, limit);
  }

  async get(vectorId: string): Promise<VectorStoreResult | null> {
    await this.initialized;
    const stmt = await this.conn.prepare(
      `MATCH (v:MemVector {id: $id})
       RETURN v.id AS id, v.payload AS payload`,
    );
    const result = await this.conn.execute(stmt, { id: vectorId });
    const rows = (await result.getAll()) as { id: string; payload: string }[];
    if (!rows.length) return null;
    return { id: rows[0].id, payload: JSON.parse(rows[0].payload) };
  }

  async update(
    vectorId: string,
    vector: number[] | null,
    payload: Record<string, any>,
  ): Promise<void> {
    await this.initialized;
    if (vector !== null) {
      const stmt = await this.conn.prepare(
        `MATCH (v:MemVector {id: $id})
         SET v.user_id = $uid, v.vec = $vec, v.payload = $payload`,
      );
      await this.conn.execute(stmt, {
        id: vectorId,
        uid: (payload.userId as string) ?? "",
        vec: vector,
        payload: JSON.stringify(payload),
      });
    } else {
      const stmt = await this.conn.prepare(
        `MATCH (v:MemVector {id: $id})
         SET v.user_id = $uid, v.payload = $payload`,
      );
      await this.conn.execute(stmt, {
        id: vectorId,
        uid: (payload.userId as string) ?? "",
        payload: JSON.stringify(payload),
      });
    }
  }

  async delete(vectorId: string): Promise<void> {
    await this.initialized;
    const stmt = await this.conn.prepare(
      `MATCH (v:MemVector {id: $id}) DELETE v`,
    );
    await this.conn.execute(stmt, { id: vectorId });
  }

  async deleteCol(): Promise<void> {
    await this.initialized;
    await this.conn.query(`MATCH (v:MemVector) DELETE v`);
  }

  async list(
    filters?: SearchFilters,
    limit = 100,
  ): Promise<[VectorStoreResult[], number]> {
    await this.initialized;
    const stmt = await this.conn.prepare(
      `MATCH (v:MemVector)
       RETURN v.id AS id, v.payload AS payload
       LIMIT $limit`,
    );
    const result = await this.conn.execute(stmt, { limit });
    const all: VectorStoreResult[] = (
      (await result.getAll()) as { id: string; payload: string }[]
    )
      .map((r) => ({ id: r.id, payload: JSON.parse(r.payload) }))
      .filter((r) => this.matchesFilters(r.payload, filters));

    return [all, all.length];
  }

  async getUserId(): Promise<string> {
    return this.userId;
  }

  async setUserId(userId: string): Promise<void> {
    this.userId = userId;
  }

  async reset(): Promise<void> {
    await this.deleteCol();
  }

  private matchesFilters(
    payload: Record<string, any>,
    filters?: SearchFilters,
  ): boolean {
    if (!filters) return true;
    return Object.entries(filters).every(([k, v]) => payload[k] === v);
  }

  close(): void {
    try {
      this.conn.close();
      this.db.close();
    } catch {
      // best-effort
    }
  }
}

