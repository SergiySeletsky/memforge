import neo4j, { Driver, Session } from "neo4j-driver";
import { VectorStore } from "./base";
import { SearchFilters, VectorStoreConfig, VectorStoreResult } from "../types";

interface MemgraphVectorStoreConfig extends VectorStoreConfig {
  url?: string;
  username?: string;
  password?: string;
  /** Name of the Memgraph vector index (default: "mem0_vectors") */
  indexName?: string;
  metric?: "cos" | "l2";
}

export class MemgraphVectorStore implements VectorStore {
  private driver: Driver;
  private indexName: string;
  private dimension: number;
  private metric: "cos" | "l2";
  private userId = "";
  private initialized: Promise<void>;

  constructor(config: MemgraphVectorStoreConfig) {
    this.indexName = config.indexName || config.collectionName || "mem0_vectors";
    this.dimension = config.dimension || 1536;
    this.metric = config.metric || "cos";
    this.driver = neo4j.driver(
      config.url || process.env.MEMGRAPH_URL || "bolt://localhost:7687",
      neo4j.auth.basic(
        config.username || process.env.MEMGRAPH_USER || "memgraph",
        config.password || process.env.MEMGRAPH_PASSWORD || "memgraph",
      ),
      { disableLosslessIntegers: true },
    );
    this.initialized = this.init();
  }

  private async withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const session = this.driver.session();
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  private async init(): Promise<void> {
    await this.withSession((s) =>
      s.run(
        `CREATE VECTOR INDEX ${this.indexName} ON :MemVector(embedding)
         WITH CONFIG {"dimension": ${this.dimension}, "capacity": 100000, "metric": "${this.metric}"}`,
      ).catch((e: Error) => {
        // Swallow only "index already exists" — a benign race condition on startup.
        // All other errors (auth, schema mismatch, network) must propagate.
        if (!/already exists/i.test(e.message)) throw e;
      }),
    );
  }

  async initialize(): Promise<void> {
    await this.initialized;
  }

  async insert(
    vectors: number[][],
    ids: string[],
    payloads: Record<string, any>[],
  ): Promise<void> {
    await this.initialized;
    // Build row objects and use UNWIND so the entire batch is one round-trip
    // instead of N sequential queries (inspired by graphiti's Neo4j save_bulk).
    // user_id is stored as a dedicated node property to enable Cypher-side
    // pre-filtering in search() without scanning every user's vectors.
    const rows = vectors.map((embedding, i) => ({
      id: ids[i],
      user_id: (payloads[i].userId as string) ?? "",
      embedding,
      payload: JSON.stringify(payloads[i]),
    }));
    await this.withSession((s) =>
      s.run(
        `UNWIND $rows AS row
         MERGE (v:MemVector {id: row.id})
         SET v.user_id   = row.user_id,
             v.embedding = row.embedding,
             v.payload   = row.payload`,
        { rows },
      ),
    );
  }

  async search(
    query: number[],
    limit: number = 10,
    filters?: SearchFilters,
    /** Minimum similarity score threshold (0–1). Results below this are dropped. */
    minScore: number = 0,
  ): Promise<VectorStoreResult[]> {
    await this.initialized;
    // Pass userId as a Cypher parameter so Memgraph filters nodes before returning
    // them to JS. Empty string means "no user filter" (matches all nodes).
    // This mirrors graphiti's WHERE score > $min_score pattern: keep filtering
    // logic inside the query rather than purely in JS.
    const uid = this.userId;
    return this.withSession(async (s) => {
      // CALL vector_search.search() returns top-k by cosine similarity.
      // The WHERE clause after YIELD is standard Cypher supported by Memgraph
      // and pre-filters by user_id before results reach JS.
      const result = await s.run(
        `CALL vector_search.search($idx, $k, $query) YIELD node, similarity
         WHERE $uid = '' OR node.user_id = $uid
         RETURN node.id AS id, node.payload AS payload, similarity AS score`,
        { idx: this.indexName, k: neo4j.int(limit * 4), query, uid },
      );

      return result.records
        .map((r) => ({
          id: r.get("id") as string,
          payload: JSON.parse(r.get("payload") as string),
          score: r.get("score") as number,
        }))
        .filter((r) => r.score >= minScore && this.matchesFilters(r.payload, filters))
        .slice(0, limit);
    });
  }

  async get(vectorId: string): Promise<VectorStoreResult | null> {
    await this.initialized;
    return this.withSession(async (s) => {
      const result = await s.run(
        "MATCH (v:MemVector {id: $id}) RETURN v",
        { id: vectorId },
      );
      if (!result.records.length) return null;
      const node = result.records[0].get("v").properties;
      return { id: node.id as string, payload: JSON.parse(node.payload as string) };
    });
  }

  async update(
    vectorId: string,
    vector: number[] | null,
    payload: Record<string, any>,
  ): Promise<void> {
    await this.initialized;
    // Use two separate prepared statements rather than Cypher string interpolation.
    // This avoids injecting conditional fragments into the query template and keeps
    // each prepared statement self-contained (inspired by graphiti's Neo4j patterns).
    const uid = (payload.userId as string) ?? "";
    const serialised = JSON.stringify(payload);
    await this.withSession(async (s) => {
      if (vector !== null) {
        await s.run(
          `MATCH (v:MemVector {id: $id})
           SET v.user_id = $uid, v.embedding = $embedding, v.payload = $payload`,
          { id: vectorId, uid, embedding: vector, payload: serialised },
        );
      } else {
        await s.run(
          `MATCH (v:MemVector {id: $id})
           SET v.user_id = $uid, v.payload = $payload`,
          { id: vectorId, uid, payload: serialised },
        );
      }
    });
  }

  async delete(vectorId: string): Promise<void> {
    await this.initialized;
    await this.withSession((s) =>
      s.run("MATCH (v:MemVector {id: $id}) DETACH DELETE v", { id: vectorId }),
    );
  }

  async deleteCol(): Promise<void> {
    await this.initialized;
    await this.withSession((s) => s.run("MATCH (v:MemVector) DETACH DELETE v"));
  }

  async healthCheck(): Promise<void> {
    // Mirrors graphiti's health_check() → verify_connectivity() pattern.
    await this.driver.verifyConnectivity();
  }

  async list(
    filters?: SearchFilters,
    limit: number = 100,
  ): Promise<[VectorStoreResult[], number]> {
    await this.initialized;
    return this.withSession(async (s) => {
      // neo4j.int() ensures the driver sends an integer type — plain JS numbers
      // are treated as floats by the bolt protocol which Memgraph rejects for LIMIT.
      const result = await s.run("MATCH (v:MemVector) RETURN v LIMIT $limit", {
        limit: neo4j.int(limit),
      });
      const all: VectorStoreResult[] = result.records
        .map((r) => {
          const node = r.get("v").properties;
          const payload = JSON.parse(node.payload as string);
          return { id: node.id as string, payload };
        })
        .filter((r) => this.matchesFilters(r.payload, filters));
      return [all, all.length] as [VectorStoreResult[], number];
    });
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

  private matchesFilters(payload: Record<string, any>, filters?: SearchFilters): boolean {
    if (!filters) return true;
    return Object.entries(filters).every(([k, v]) => payload[k] === v);
  }

  close(): void {
    this.driver.close().catch((e) => console.warn("[MemgraphVectorStore] close error:", e));
  }
}
