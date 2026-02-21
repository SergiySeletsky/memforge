/**
 * MemgraphGraphStore — Memgraph implementation of the GraphStore interface.
 *
 * Uses the neo4j-driver bolt protocol to communicate with Memgraph.
 * Entity nodes are stored as `:Entity` nodes with:
 *   { id, name, type, user_id, embedding, created_at, updated_at, ...properties }
 *
 * Relationships are dynamic Cypher relationship types (e.g. `:KNOWS`, `:USES`).
 * A secondary label from the entity type is added for efficient typed queries.
 *
 * Similarity search on entity embeddings uses Memgraph MAGE
 * `vector_search.search()` when a vector index exists, falling back to
 * brute-force cosine in Cypher otherwise.
 */

import neo4j, { Driver, Session } from "neo4j-driver";
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

interface MemgraphGraphStoreConfig {
  url?: string;
  username?: string;
  password?: string;
  /** Name of the Memgraph vector index for entity embeddings (default: "entity_vectors") */
  indexName?: string;
  /** Embedding dimension (default: 1536) */
  dimension?: number;
  /** Similarity metric: "cos" (default) or "l2" */
  metric?: "cos" | "l2";
}

export class MemgraphGraphStore implements GraphStore {
  private driver: Driver;
  private indexName: string;
  private dimension: number;
  private metric: "cos" | "l2";
  private initialized: Promise<void>;

  constructor(config: MemgraphGraphStoreConfig = {}) {
    this.indexName = config.indexName ?? "entity_vectors";
    this.dimension = config.dimension ?? 1536;
    this.metric = config.metric ?? "cos";
    this.driver = neo4j.driver(
      config.url ?? process.env.MEMGRAPH_URL ?? "bolt://localhost:7687",
      neo4j.auth.basic(
        config.username ?? process.env.MEMGRAPH_USER ?? "memgraph",
        config.password ?? process.env.MEMGRAPH_PASSWORD ?? "memgraph",
      ),
      { disableLosslessIntegers: true },
    );
    this.initialized = this.init();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    const session = this.driver.session();
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  private userId(filters: SearchFilters): string {
    return filters.userId ?? filters.agentId ?? filters.runId ?? "";
  }

  // ─── Initialization ──────────────────────────────────────────────────────

  private async init(): Promise<void> {
    await this.withSession(async (s) => {
      // Vector index on Entity.embedding for HNSW similarity search
      await s
        .run(
          `CREATE VECTOR INDEX ${this.indexName} ON :Entity(embedding)
           WITH CONFIG {"dimension": ${this.dimension}, "capacity": 100000, "metric": "${this.metric}"}`,
        )
        .catch((e: Error) => {
          if (!/already exists/i.test(e.message)) throw e;
        });

      // Uniqueness constraint on Entity.id (idempotent)
      await s
        .run(`CREATE CONSTRAINT ON (e:Entity) ASSERT e.id IS UNIQUE`)
        .catch((e: Error) => {
          if (!/already exists/i.test(e.message)) throw e;
        });
    });
  }

  async initialize(): Promise<void> {
    await this.initialized;
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

    return this.withSession(async (s) => {
      // Use MAGE vector_search for HNSW ANN
      const result = await s.run(
        `CALL vector_search.search('${this.indexName}', $limit, $queryEmbedding)
         YIELD node, similarity
         WHERE node.user_id = $uid AND similarity >= $threshold
         RETURN node.id AS id, node.name AS name, node.type AS type,
                node.properties AS properties, similarity
         ORDER BY similarity DESC
         LIMIT toInteger($limit)`,
        {
          queryEmbedding,
          uid,
          limit: neo4j.int(limit),
          threshold,
        },
      );

      return result.records.map((r) => ({
        id: r.get("id"),
        name: r.get("name"),
        type: r.get("type") ?? undefined,
        properties: r.get("properties") ? JSON.parse(r.get("properties")) : {},
        score: r.get("similarity"),
      }));
    });
  }

  async getNode(
    nodeId: string,
    filters: SearchFilters,
  ): Promise<GraphNode | null> {
    await this.initialized;
    const uid = this.userId(filters);

    return this.withSession(async (s) => {
      const result = await s.run(
        `MATCH (e:Entity {id: $nodeId, user_id: $uid})
         RETURN e.id AS id, e.name AS name, e.type AS type,
                e.properties AS properties, e.embedding AS embedding`,
        { nodeId, uid },
      );

      if (result.records.length === 0) return null;
      const r = result.records[0];
      return {
        id: r.get("id"),
        name: r.get("name"),
        type: r.get("type") ?? undefined,
        embedding: r.get("embedding") ?? undefined,
        properties: r.get("properties") ? JSON.parse(r.get("properties")) : {},
      };
    });
  }

  async deleteNode(nodeId: string, filters: SearchFilters): Promise<void> {
    await this.initialized;
    const uid = this.userId(filters);

    await this.withSession((s) =>
      s.run(
        `MATCH (e:Entity {id: $nodeId, user_id: $uid}) DETACH DELETE e`,
        { nodeId, uid },
      ),
    );
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

    return this.withSession(async (s) => {
      // Find nodes similar to query, then return their outgoing AND incoming edges
      const result = await s.run(
        `CALL vector_search.search('${this.indexName}', $searchLimit, $queryEmbedding)
         YIELD node, similarity
         WHERE node.user_id = $uid AND similarity >= $threshold
         WITH node, similarity
         ORDER BY similarity DESC
         LIMIT toInteger($searchLimit)
         OPTIONAL MATCH (node)-[r]->(target:Entity {user_id: $uid})
         WITH node.name AS source, type(r) AS rel, target.name AS target, similarity
         WHERE rel IS NOT NULL
         RETURN source, rel AS relationship, target, similarity
         UNION
         CALL vector_search.search('${this.indexName}', $searchLimit, $queryEmbedding)
         YIELD node, similarity
         WHERE node.user_id = $uid AND similarity >= $threshold
         WITH node, similarity
         ORDER BY similarity DESC
         LIMIT toInteger($searchLimit)
         OPTIONAL MATCH (source:Entity {user_id: $uid})-[r]->(node)
         WITH source.name AS source, type(r) AS rel, node.name AS target, similarity
         WHERE rel IS NOT NULL
         RETURN source, rel AS relationship, target, similarity
         ORDER BY similarity DESC
         LIMIT toInteger($resultLimit)`,
        {
          queryEmbedding,
          uid,
          threshold,
          searchLimit: neo4j.int(limit * 2),
          resultLimit: neo4j.int(limit),
        },
      );

      // Deduplicate triples
      const seen = new Set<string>();
      const triples: RelationTriple[] = [];
      for (const r of result.records) {
        const key = `${r.get("source")}|${r.get("relationship")}|${r.get("target")}`;
        if (!seen.has(key)) {
          seen.add(key);
          triples.push({
            source: r.get("source"),
            relationship: r.get("relationship"),
            target: r.get("target"),
            score: r.get("similarity"),
          });
        }
      }
      return triples.slice(0, limit);
    });
  }

  async upsertRelationship(
    input: UpsertRelationshipInput,
    embedding: { source: number[]; target: number[] },
    filters: SearchFilters,
  ): Promise<GraphEdge> {
    await this.initialized;
    const uid = this.userId(filters);
    const sourceType = input.sourceType ?? "entity";
    const targetType = input.targetType ?? "entity";
    const rel = input.relationship.toUpperCase().replace(/\s+/g, "_");
    const props = input.properties ? JSON.stringify(input.properties) : "{}";
    const now = new Date().toISOString();

    return this.withSession(async (s) => {
      // Dynamic relationship types require string interpolation in Cypher.
      // Source/target names are passed as parameters to prevent injection.
      const result = await s.run(
        `MERGE (src:Entity {name: $srcName, user_id: $uid})
         ON CREATE SET src.id = $srcId, src.type = $srcType,
                       src.embedding = $srcEmb, src.created_at = $now,
                       src.updated_at = $now, src.properties = '{}'
         ON MATCH SET  src.embedding = $srcEmb, src.updated_at = $now
         MERGE (tgt:Entity {name: $tgtName, user_id: $uid})
         ON CREATE SET tgt.id = $tgtId, tgt.type = $tgtType,
                       tgt.embedding = $tgtEmb, tgt.created_at = $now,
                       tgt.updated_at = $now, tgt.properties = '{}'
         ON MATCH SET  tgt.embedding = $tgtEmb, tgt.updated_at = $now
         MERGE (src)-[r:${rel}]->(tgt)
         ON CREATE SET r.id = $relId, r.created_at = $now, r.properties = $props
         ON MATCH SET  r.updated_at = $now, r.properties = $props
         RETURN src.id AS srcId, src.name AS srcName,
                r.id AS relId, type(r) AS relType,
                tgt.id AS tgtId, tgt.name AS tgtName`,
        {
          srcName: input.sourceName.toLowerCase().replace(/\s+/g, "_"),
          srcId: randomUUID(),
          srcType: sourceType,
          srcEmb: embedding.source,
          tgtName: input.targetName.toLowerCase().replace(/\s+/g, "_"),
          tgtId: randomUUID(),
          tgtType: targetType,
          tgtEmb: embedding.target,
          relId: randomUUID(),
          uid,
          now,
          props,
        },
      );

      const r = result.records[0];
      return {
        id: r.get("relId"),
        sourceId: r.get("srcId"),
        sourceName: r.get("srcName"),
        relationship: r.get("relType"),
        targetId: r.get("tgtId"),
        targetName: r.get("tgtName"),
        properties: input.properties ?? {},
      };
    });
  }

  async deleteRelationship(
    sourceName: string,
    relationship: string,
    targetName: string,
    filters: SearchFilters,
  ): Promise<void> {
    await this.initialized;
    const uid = this.userId(filters);
    const rel = relationship.toUpperCase().replace(/\s+/g, "_");

    await this.withSession((s) =>
      s.run(
        `MATCH (src:Entity {name: $srcName, user_id: $uid})
               -[r:${rel}]->
               (tgt:Entity {name: $tgtName, user_id: $uid})
         DELETE r`,
        {
          srcName: sourceName.toLowerCase().replace(/\s+/g, "_"),
          tgtName: targetName.toLowerCase().replace(/\s+/g, "_"),
          uid,
        },
      ),
    );
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

    // Build optional relationship type filter
    const relFilter =
      options.relationshipTypes && options.relationshipTypes.length > 0
        ? `:${options.relationshipTypes.join("|")}`
        : "";

    return this.withSession(async (s) => {
      const result = await s.run(
        `MATCH (center:Entity {id: $nodeId, user_id: $uid})
         CALL {
           WITH center
           MATCH path = (center)-[${relFilter}*1..${depth}]-(neighbor:Entity {user_id: $uid})
           UNWIND relationships(path) AS rel
           WITH DISTINCT
             startNode(rel) AS src, rel, endNode(rel) AS tgt,
             neighbor
           RETURN
             collect(DISTINCT {
               id: neighbor.id, name: neighbor.name, type: neighbor.type,
               properties: neighbor.properties
             }) AS neighborNodes,
             collect(DISTINCT {
               id: COALESCE(rel.id, toString(id(rel))),
               srcId: src.id, srcName: src.name,
               relType: type(rel),
               tgtId: tgt.id, tgtName: tgt.name,
               properties: COALESCE(rel.properties, '{}')
             }) AS edgeList
         }
         RETURN neighborNodes, edgeList
         LIMIT toInteger($limit)`,
        { nodeId, uid, limit: neo4j.int(limit) },
      );

      if (result.records.length === 0) {
        return { nodes: [], edges: [] };
      }

      const rec = result.records[0];
      const rawNodes: any[] = rec.get("neighborNodes") ?? [];
      const rawEdges: any[] = rec.get("edgeList") ?? [];

      const nodes: GraphNode[] = rawNodes.map((n: any) => ({
        id: n.id,
        name: n.name,
        type: n.type ?? undefined,
        properties: n.properties ? JSON.parse(n.properties) : {},
      }));

      const edges: GraphEdge[] = rawEdges.map((e: any) => ({
        id: e.id,
        sourceId: e.srcId,
        sourceName: e.srcName,
        relationship: e.relType,
        targetId: e.tgtId,
        targetName: e.tgtName,
        properties: e.properties ? JSON.parse(e.properties) : {},
      }));

      return { nodes, edges };
    });
  }

  async getSubgraph(
    nodeId: string,
    filters: SearchFilters,
    options: TraversalOptions = {},
  ): Promise<Subgraph> {
    await this.initialized;
    const uid = this.userId(filters);
    const depth = options.depth ?? 1;
    const limit = options.limit ?? 50;

    const relFilter =
      options.relationshipTypes && options.relationshipTypes.length > 0
        ? `:${options.relationshipTypes.join("|")}`
        : "";

    return this.withSession(async (s) => {
      // Ego-graph: find all neighbors, then return ALL edges between them
      const result = await s.run(
        `MATCH (center:Entity {id: $nodeId, user_id: $uid})
         OPTIONAL MATCH path = (center)-[${relFilter}*1..${depth}]-(neighbor:Entity {user_id: $uid})
         WITH center, collect(DISTINCT neighbor) AS neighbors
         WITH center, neighbors, [center] + neighbors AS allNodes
         UNWIND allNodes AS n
         WITH DISTINCT n, allNodes
         OPTIONAL MATCH (n)-[r]->(m)
         WHERE m IN allNodes
         RETURN
           collect(DISTINCT {
             id: n.id, name: n.name, type: n.type,
             properties: COALESCE(n.properties, '{}')
           }) AS subNodes,
           collect(DISTINCT {
             id: COALESCE(r.id, toString(id(r))),
             srcId: n.id, srcName: n.name,
             relType: type(r),
             tgtId: m.id, tgtName: m.name,
             properties: COALESCE(r.properties, '{}')
           }) AS subEdges
         LIMIT toInteger($limit)`,
        { nodeId, uid, limit: neo4j.int(limit) },
      );

      if (result.records.length === 0) {
        return { nodes: [], edges: [] };
      }

      const rec = result.records[0];
      const rawNodes: any[] = rec.get("subNodes") ?? [];
      const rawEdges: any[] = rec.get("subEdges") ?? [];

      const nodes: GraphNode[] = rawNodes.map((n: any) => ({
        id: n.id,
        name: n.name,
        type: n.type ?? undefined,
        properties: n.properties ? JSON.parse(n.properties) : {},
      }));

      // Filter out null-relationship edges (from the OPTIONAL MATCH when a node has no outgoing)
      const edges: GraphEdge[] = rawEdges
        .filter((e: any) => e.relType != null)
        .map((e: any) => ({
          id: e.id,
          sourceId: e.srcId,
          sourceName: e.srcName,
          relationship: e.relType,
          targetId: e.tgtId,
          targetName: e.tgtName,
          properties: e.properties ? JSON.parse(e.properties) : {},
        }));

      return { nodes, edges };
    });
  }

  // ─── Bulk ────────────────────────────────────────────────────────────────

  async getAll(
    filters: SearchFilters,
    limit = 100,
  ): Promise<RelationTriple[]> {
    await this.initialized;
    const uid = this.userId(filters);

    return this.withSession(async (s) => {
      const result = await s.run(
        `MATCH (src:Entity {user_id: $uid})-[r]->(tgt:Entity {user_id: $uid})
         RETURN src.name AS source, type(r) AS relationship, tgt.name AS target
         LIMIT toInteger($limit)`,
        { uid, limit: neo4j.int(limit) },
      );

      return result.records.map((r) => ({
        source: r.get("source"),
        relationship: r.get("relationship"),
        target: r.get("target"),
      }));
    });
  }

  async deleteAll(filters: SearchFilters): Promise<void> {
    await this.initialized;
    const uid = this.userId(filters);

    await this.withSession((s) =>
      s.run(`MATCH (e:Entity {user_id: $uid}) DETACH DELETE e`, { uid }),
    );
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
