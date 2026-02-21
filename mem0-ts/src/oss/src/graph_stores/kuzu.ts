/**
 * KuzuGraphStore — KuzuDB implementation of the GraphStore interface.
 *
 * KuzuDB is an embedded graph database — no server required. All data lives
 * in-process (or on disk at `dbPath`).
 *
 * ── Schema ───────────────────────────────────────────────────────────────────
 *
 *   Entity (node table):
 *     id STRING PK, name STRING, type STRING, user_id STRING,
 *     embedding FLOAT[], properties STRING, created_at STRING, updated_at STRING
 *
 *   RELATES_TO (rel table  Entity → Entity):
 *     id STRING, rel_type STRING, properties STRING,
 *     created_at STRING, updated_at STRING
 *
 * Unlike Neo4j/Memgraph, KuzuDB requires rel tables to be pre-declared (no
 * dynamic relationship types).  We use a single `RELATES_TO` rel table with a
 * `rel_type` property that stores the semantic relationship label.
 *
 * ── Similarity search ────────────────────────────────────────────────────────
 * KuzuDB 0.9 has no ANN index — search is brute-force `array_cosine_similarity`.
 * Acceptable for small-to-medium entity graphs (< 50k nodes).
 *
 * ── KuzuDB quirks (all accounted for) ────────────────────────────────────────
 * See the KuzuVectorStore class docs for the full list.  Key items:
 *   - CAST($vec AS FLOAT[dim]) required for similarity functions
 *   - Integer params + CAST crash — inline LIMIT as literal
 *   - conn.prepare() + conn.execute(stmt, params) for parameterized queries
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const kuzu = require("kuzu") as typeof import("kuzu");
import path from "path";
import {
  GraphStore,
  GraphNode,
  GraphEdge,
  RelationTriple,
  Subgraph,
  UpsertRelationshipInput,
  TraversalOptions,
} from "./base";
import { SearchFilters } from "../types";
import { randomUUID } from "crypto";

interface KuzuGraphStoreConfig {
  /** Path to the KuzuDB database directory. Omit or ":memory:" for in-process transient store. */
  dbPath?: string;
  /** Embedding dimension (default: 1536) */
  dimension?: number;
}

export class KuzuGraphStore implements GraphStore {
  private db: InstanceType<(typeof kuzu)["Database"]>;
  private conn: InstanceType<(typeof kuzu)["Connection"]>;
  private dimension: number;
  private initialized: Promise<void>;

  constructor(config: KuzuGraphStoreConfig = {}) {
    this.dimension = config.dimension ?? 1536;
    const raw = config.dbPath;
    this.db =
      raw && raw !== ":memory:"
        ? new kuzu.Database(path.resolve(raw))
        : new kuzu.Database();
    this.conn = new kuzu.Connection(this.db);
    this.initialized = this.init();
  }

  // ─── Schema ──────────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    await this.conn.query(
      `CREATE NODE TABLE IF NOT EXISTS Entity (
         id         STRING,
         name       STRING,
         type       STRING,
         user_id    STRING,
         embedding  FLOAT[],
         properties STRING,
         created_at STRING,
         updated_at STRING,
         PRIMARY KEY (id)
       )`,
    );

    await this.conn.query(
      `CREATE REL TABLE IF NOT EXISTS RELATES_TO (
         FROM Entity TO Entity,
         id         STRING,
         rel_type   STRING,
         properties STRING,
         created_at STRING,
         updated_at STRING
       )`,
    );
  }

  async initialize(): Promise<void> {
    await this.initialized;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private userId(filters: SearchFilters): string {
    return filters.userId ?? filters.agentId ?? filters.runId ?? "";
  }

  // ─── Node CRUD ───────────────────────────────────────────────────────────

  async searchNodes(
    queryEmbedding: number[],
    filters: SearchFilters,
    limit = 10,
    threshold = 0.5,
  ): Promise<GraphNode[]> {
    await this.initialized;
    const uid = this.userId(filters);
    const cast = `CAST($vec AS FLOAT[${this.dimension}])`;

    const stmt = await this.conn.prepare(
      `MATCH (e:Entity)
       WHERE e.user_id = $uid AND e.embedding IS NOT NULL
       WITH e, array_cosine_similarity(e.embedding, ${cast}) AS score
       WHERE score >= ${threshold}
       RETURN e.id AS id, e.name AS name, e.type AS type,
              e.properties AS properties, score
       ORDER BY score DESC
       LIMIT ${limit}`,
    );
    const result = await this.conn.execute(stmt, { uid, vec: queryEmbedding });
    const rows = (await result.getAll()) as Array<{
      id: string; name: string; type: string;
      properties: string; score: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type || undefined,
      properties: r.properties ? JSON.parse(r.properties) : {},
      score: r.score,
    }));
  }

  async getNode(
    nodeId: string,
    filters: SearchFilters,
  ): Promise<GraphNode | null> {
    await this.initialized;
    const uid = this.userId(filters);

    const stmt = await this.conn.prepare(
      `MATCH (e:Entity {id: $nodeId})
       WHERE e.user_id = $uid
       RETURN e.id AS id, e.name AS name, e.type AS type,
              e.properties AS properties, e.embedding AS embedding`,
    );
    const result = await this.conn.execute(stmt, { nodeId, uid });
    const rows = (await result.getAll()) as Array<{
      id: string; name: string; type: string;
      properties: string; embedding: number[];
    }>;

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      type: r.type || undefined,
      embedding: r.embedding ?? undefined,
      properties: r.properties ? JSON.parse(r.properties) : {},
    };
  }

  async deleteNode(nodeId: string, filters: SearchFilters): Promise<void> {
    await this.initialized;
    const uid = this.userId(filters);

    const stmt = await this.conn.prepare(
      `MATCH (e:Entity {id: $nodeId})
       WHERE e.user_id = $uid
       DETACH DELETE e`,
    );
    await this.conn.execute(stmt, { nodeId, uid });
  }

  // ─── Edge / Relationship CRUD ────────────────────────────────────────────

  async searchEdges(
    queryEmbedding: number[],
    filters: SearchFilters,
    limit = 10,
    threshold = 0.5,
  ): Promise<RelationTriple[]> {
    await this.initialized;
    const uid = this.userId(filters);
    const cast = `CAST($vec AS FLOAT[${this.dimension}])`;

    // Find similar entities, then return their outgoing relationships
    const outStmt = await this.conn.prepare(
      `MATCH (e:Entity)
       WHERE e.user_id = $uid AND e.embedding IS NOT NULL
       WITH e, array_cosine_similarity(e.embedding, ${cast}) AS score
       WHERE score >= ${threshold}
       RETURN e.id AS entityId, e.name AS entityName, score
       ORDER BY score DESC
       LIMIT ${limit * 2}`,
    );
    const outResult = await this.conn.execute(outStmt, { uid, vec: queryEmbedding });
    const similarEntities = (await outResult.getAll()) as Array<{
      entityId: string; entityName: string; score: number;
    }>;

    // Collect relationships for each similar entity
    const rows: Array<{ source: string; relationship: string; target: string; score: number }> = [];
    for (const ent of similarEntities) {
      // Outgoing
      const outRelStmt = await this.conn.prepare(
        `MATCH (e:Entity {id: $entityId})-[r:RELATES_TO]->(tgt:Entity)
         WHERE tgt.user_id = $uid
         RETURN e.name AS source, r.rel_type AS relationship, tgt.name AS target`,
      );
      const outRelResult = await this.conn.execute(outRelStmt, { entityId: ent.entityId, uid });
      const outRels = (await outRelResult.getAll()) as Array<{ source: string; relationship: string; target: string }>;
      for (const r of outRels) rows.push({ ...r, score: ent.score });

      // Incoming
      const inRelStmt = await this.conn.prepare(
        `MATCH (src:Entity)-[r:RELATES_TO]->(e:Entity {id: $entityId})
         WHERE src.user_id = $uid
         RETURN src.name AS source, r.rel_type AS relationship, e.name AS target`,
      );
      const inRelResult = await this.conn.execute(inRelStmt, { entityId: ent.entityId, uid });
      const inRels = (await inRelResult.getAll()) as Array<{ source: string; relationship: string; target: string }>;
      for (const r of inRels) rows.push({ ...r, score: ent.score });
    }

    // Deduplicate & filter null relationships
    const seen = new Set<string>();
    const triples: RelationTriple[] = [];
    for (const r of rows) {
      if (!r.relationship) continue;
      const key = `${r.source}|${r.relationship}|${r.target}`;
      if (!seen.has(key)) {
        seen.add(key);
        triples.push({
          source: r.source,
          relationship: r.relationship,
          target: r.target,
          score: r.score,
        });
      }
    }
    return triples.slice(0, limit);
  }

  /** Upsert a single Entity node by name+user_id. Returns the node's id. */
  private async upsertNode(
    name: string,
    type: string,
    uid: string,
    emb: number[],
    now: string,
  ): Promise<string> {
    // Step 1: Check if node already exists
    const findStmt = await this.conn.prepare(
      `MATCH (e:Entity)
       WHERE e.name = $name AND e.user_id = $uid
       RETURN e.id AS id`,
    );
    const findResult = await this.conn.execute(findStmt, { name, uid });
    const existing = (await findResult.getAll()) as Array<{ id: string }>;

    if (existing.length > 0) {
      // Update existing node
      const nodeId = existing[0].id;
      const updateStmt = await this.conn.prepare(
        `MATCH (e:Entity {id: $id})
         SET e.embedding = $emb, e.updated_at = $now`,
      );
      await this.conn.execute(updateStmt, { id: nodeId, emb, now });
      return nodeId;
    } else {
      // Create new node
      const nodeId = randomUUID();
      const createStmt = await this.conn.prepare(
        `CREATE (e:Entity {
           id: $id, name: $name, type: $type, user_id: $uid,
           embedding: $emb, properties: $props,
           created_at: $now, updated_at: $now
         })`,
      );
      await this.conn.execute(createStmt, {
        id: nodeId, name, type, uid, emb, props: "{}", now,
      });
      return nodeId;
    }
  }

  async upsertRelationship(
    input: UpsertRelationshipInput,
    embedding: { source: number[]; target: number[] },
    filters: SearchFilters,
  ): Promise<GraphEdge> {
    await this.initialized;
    const uid = this.userId(filters);
    const now = new Date().toISOString();
    const relType = input.relationship.toUpperCase().replace(/\s+/g, "_");
    const srcName = input.sourceName.toLowerCase().replace(/\s+/g, "_");
    const tgtName = input.targetName.toLowerCase().replace(/\s+/g, "_");
    const srcType = input.sourceType ?? "entity";
    const tgtType = input.targetType ?? "entity";
    const props = input.properties ? JSON.stringify(input.properties) : "{}";

    // Step 1 & 2: Upsert source and target entities
    const finalSrcId = await this.upsertNode(srcName, srcType, uid, embedding.source, now);
    const finalTgtId = await this.upsertNode(tgtName, tgtType, uid, embedding.target, now);

    // Step 3: Delete existing relationship of same type between these nodes
    const delRel = await this.conn.prepare(
      `MATCH (src:Entity {id: $srcId})-[r:RELATES_TO]->(tgt:Entity {id: $tgtId})
       WHERE r.rel_type = $relType
       DELETE r`,
    );
    await this.conn.execute(delRel, { srcId: finalSrcId, tgtId: finalTgtId, relType }).catch(() => {
      // No existing relationship — that's fine
    });

    // Step 4: Create relationship
    const relId = randomUUID();
    const createRel = await this.conn.prepare(
      `MATCH (src:Entity {id: $srcId}),
             (tgt:Entity {id: $tgtId})
       CREATE (src)-[r:RELATES_TO {
         id: $relId, rel_type: $relType, properties: $props,
         created_at: $now, updated_at: $now
       }]->(tgt)
       RETURN r.id AS relId`,
    );
    await this.conn.execute(createRel, {
      srcId: finalSrcId, tgtId: finalTgtId, relId, relType, props, now,
    });

    return {
      id: relId,
      sourceId: finalSrcId,
      sourceName: srcName,
      relationship: relType,
      targetId: finalTgtId,
      targetName: tgtName,
      properties: input.properties ?? {},
    };
  }

  async deleteRelationship(
    sourceName: string,
    relationship: string,
    targetName: string,
    filters: SearchFilters,
  ): Promise<void> {
    await this.initialized;
    const uid = this.userId(filters);
    const relType = relationship.toUpperCase().replace(/\s+/g, "_");

    const stmt = await this.conn.prepare(
      `MATCH (src:Entity {name: $srcName, user_id: $uid})
             -[r:RELATES_TO {rel_type: $relType}]->
             (tgt:Entity {name: $tgtName, user_id: $uid})
       DELETE r`,
    );
    await this.conn.execute(stmt, {
      srcName: sourceName.toLowerCase().replace(/\s+/g, "_"),
      tgtName: targetName.toLowerCase().replace(/\s+/g, "_"),
      uid,
      relType,
    });
  }

  // ─── Traversal ───────────────────────────────────────────────────────────

  async getNeighborhood(
    nodeId: string,
    filters: SearchFilters,
    options: TraversalOptions = {},
  ): Promise<Subgraph> {
    await this.initialized;
    const uid = this.userId(filters);
    const depth = options.depth ?? 1;
    const limit = options.limit ?? 50;

    // KuzuDB supports variable-length paths: -[*1..N]-
    // But relationship type filters must go in WHERE (no inline :TYPE filter on var-length)
    const relTypeFilter =
      options.relationshipTypes && options.relationshipTypes.length > 0
        ? `AND ALL(rel IN rels(p) WHERE rel.rel_type IN [${options.relationshipTypes.map((t) => `'${t.toUpperCase().replace(/\s+/g, "_")}'`).join(",")}])`
        : "";

    // Outgoing neighbors
    const outStmt = await this.conn.prepare(
      `MATCH (center:Entity {id: $nodeId})
       WHERE center.user_id = $uid
       MATCH p = (center)-[r:RELATES_TO*1..${depth}]->(neighbor:Entity)
       WHERE neighbor.user_id = $uid ${relTypeFilter}
       RETURN DISTINCT
         neighbor.id AS nId, neighbor.name AS nName, neighbor.type AS nType,
         neighbor.properties AS nProps`,
    );
    const outResult = await this.conn.execute(outStmt, { nodeId, uid });
    const outRows = (await outResult.getAll()) as Array<{
      nId: string; nName: string; nType: string; nProps: string;
    }>;

    // Incoming neighbors
    const inStmt = await this.conn.prepare(
      `MATCH (center:Entity {id: $nodeId})
       WHERE center.user_id = $uid
       MATCH p = (neighbor:Entity)-[r:RELATES_TO*1..${depth}]->(center)
       WHERE neighbor.user_id = $uid ${relTypeFilter}
       RETURN DISTINCT
         neighbor.id AS nId, neighbor.name AS nName, neighbor.type AS nType,
         neighbor.properties AS nProps`,
    );
    const inResult = await this.conn.execute(inStmt, { nodeId, uid });
    const inRows = (await inResult.getAll()) as Array<{
      nId: string; nName: string; nType: string; nProps: string;
    }>;

    // Combine unique nodes
    const nodeMap = new Map<string, GraphNode>();
    for (const r of [...outRows, ...inRows]) {
      if (!nodeMap.has(r.nId)) {
        nodeMap.set(r.nId, {
          id: r.nId,
          name: r.nName,
          type: r.nType || undefined,
          properties: r.nProps ? JSON.parse(r.nProps) : {},
        });
      }
    }

    // Get edges between center + neighbors
    const allNodeIds = [nodeId, ...nodeMap.keys()];
    const edges = await this.getEdgesBetween(allNodeIds, uid);

    return {
      nodes: [...nodeMap.values()].slice(0, limit),
      edges: edges.slice(0, limit * 2),
    };
  }

  async getSubgraph(
    nodeId: string,
    filters: SearchFilters,
    options: TraversalOptions = {},
  ): Promise<Subgraph> {
    // For KuzuDB, getSubgraph includes edges *between* neighbors too
    const neighborhood = await this.getNeighborhood(nodeId, filters, options);

    // Get edges between ALL neighbor pairs (ego-graph)
    const uid = this.userId(filters);
    const allIds = [nodeId, ...neighborhood.nodes.map((n) => n.id)];
    const edges = await this.getEdgesBetween(allIds, uid);

    return {
      nodes: neighborhood.nodes,
      edges,
    };
  }

  /** Helper: get all RELATES_TO edges between a set of node IDs. */
  private async getEdgesBetween(
    nodeIds: string[],
    uid: string,
  ): Promise<GraphEdge[]> {
    if (nodeIds.length === 0) return [];

    // KuzuDB: parameterized IN-list with $ids
    const stmt = await this.conn.prepare(
      `MATCH (src:Entity)-[r:RELATES_TO]->(tgt:Entity)
       WHERE src.user_id = $uid AND tgt.user_id = $uid
         AND src.id IN $ids AND tgt.id IN $ids
       RETURN r.id AS relId, src.id AS srcId, src.name AS srcName,
              r.rel_type AS relType, tgt.id AS tgtId, tgt.name AS tgtName,
              r.properties AS props`,
    );
    const result = await this.conn.execute(stmt, { uid, ids: nodeIds });
    const rows = (await result.getAll()) as Array<{
      relId: string; srcId: string; srcName: string;
      relType: string; tgtId: string; tgtName: string; props: string;
    }>;

    return rows.map((r) => ({
      id: r.relId,
      sourceId: r.srcId,
      sourceName: r.srcName,
      relationship: r.relType,
      targetId: r.tgtId,
      targetName: r.tgtName,
      properties: r.props ? JSON.parse(r.props) : {},
    }));
  }

  // ─── Bulk ────────────────────────────────────────────────────────────────

  async getAll(
    filters: SearchFilters,
    limit = 100,
  ): Promise<RelationTriple[]> {
    await this.initialized;
    const uid = this.userId(filters);

    const stmt = await this.conn.prepare(
      `MATCH (src:Entity {user_id: $uid})-[r:RELATES_TO]->(tgt:Entity {user_id: $uid})
       RETURN src.name AS source, r.rel_type AS relationship, tgt.name AS target
       LIMIT ${limit}`,
    );
    const result = await this.conn.execute(stmt, { uid });
    const rows = (await result.getAll()) as Array<{
      source: string; relationship: string; target: string;
    }>;

    return rows.map((r) => ({
      source: r.source,
      relationship: r.relationship,
      target: r.target,
    }));
  }

  async deleteAll(filters: SearchFilters): Promise<void> {
    await this.initialized;
    const uid = this.userId(filters);

    // Delete relationships first, then nodes
    const delRels = await this.conn.prepare(
      `MATCH (e:Entity {user_id: $uid})-[r:RELATES_TO]->()
       DELETE r`,
    );
    await this.conn.execute(delRels, { uid });

    const delNodes = await this.conn.prepare(
      `MATCH (e:Entity {user_id: $uid}) DELETE e`,
    );
    await this.conn.execute(delNodes, { uid });
  }

  async close(): Promise<void> {
    // KuzuDB 0.9 native addon: close() can crash — best-effort only.
    // See KuzuVectorStore docs for details.
    try {
      this.conn.close();
      this.db.close();
    } catch {
      // no-op
    }
  }
}
