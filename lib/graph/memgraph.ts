/**
 * lib/graph/memgraph.ts â€” Memgraph GraphStore implementation
 *
 * Migrated from memforge-ts/oss graph_stores/memgraph.ts, rewritten to use
 * MemForge's runRead/runWrite pattern instead of raw neo4j sessions.
 *
 * Key differences from oss version:
 *   - Uses runRead/runWrite from @/lib/db/memgraph (not raw neo4j-driver)
 *   - User scoping via (User)-[:HAS_ENTITY]->(Entity) graph path
 *     (not flat user_id property filter)
 *   - Uses MemForge's entity_vectors index (initialized by instrumentation.ts)
 *   - Entity names normalized via lowercase + underscore replacement
 */

import { generateId } from "@/lib/id";
import { runRead, runWrite } from "@/lib/db/memgraph";
import type {
  GraphStore,
  GraphNode,
  GraphEdge,
  RelationTriple,
  Subgraph,
  UpsertRelationshipInput,
  TraversalOptions,
} from "./types";

/** Vector index name for entity embeddings. */
const ENTITY_INDEX_NAME = "entity_vectors";

// â”€â”€â”€ Helper: normalize entity name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

// â”€â”€â”€ Implementation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class MemgraphGraphStore implements GraphStore {
  // The entity_vectors index is created by instrumentation.ts initSchema().
  // No additional initialization needed per-instance.
  async initialize(): Promise<void> {
    // entity_vectors index is managed by initSchema() in instrumentation.ts
    // This is a no-op for the MemForge integration.
  }

  // â”€â”€ Node CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async searchNodes(
    queryEmbedding: number[],
    userId: string,
    limit: number = 10,
    threshold: number = 0.5,
  ): Promise<GraphNode[]> {
    const rows = await runRead<{
      id: string;
      name: string;
      type: string | null;
      description: string | null;
      similarity: number;
    }>(
      `CALL vector_search.search("${ENTITY_INDEX_NAME}", toInteger($fetchLimit), $queryEmbedding)
       YIELD node, similarity
       MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(node)
       WHERE similarity >= $threshold
       RETURN node.id AS id, node.name AS name, node.type AS type,
              node.description AS description, similarity
       ORDER BY similarity DESC
       LIMIT toInteger($limit)`,
      {
        queryEmbedding,
        userId,
        fetchLimit: limit * 3,
        threshold,
        limit,
      },
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type ?? undefined,
      properties: { description: r.description ?? "" },
      score: r.similarity,
    }));
  }

  async getNode(nodeId: string, userId: string): Promise<GraphNode | null> {
    const rows = await runRead<{
      id: string;
      name: string;
      type: string | null;
      description: string | null;
      embedding: number[] | null;
    }>(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity {id: $nodeId})
       RETURN e.id AS id, e.name AS name, e.type AS type,
              e.description AS description, e.embedding AS embedding`,
      { nodeId, userId },
    );

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      type: r.type ?? undefined,
      embedding: r.embedding ?? undefined,
      properties: { description: r.description ?? "" },
    };
  }

  async deleteNode(nodeId: string, userId: string): Promise<void> {
    await runWrite(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity {id: $nodeId})
       DETACH DELETE e`,
      { nodeId, userId },
    );
  }

  // â”€â”€ Edge / Relationship CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async searchEdges(
    queryEmbedding: number[],
    userId: string,
    limit: number = 10,
    threshold: number = 0.5,
  ): Promise<RelationTriple[]> {
    // Find entity nodes similar to query, then return their outgoing edges
    const rows = await runRead<{
      source: string;
      relationship: string;
      target: string;
      similarity: number;
    }>(
      `CALL vector_search.search("${ENTITY_INDEX_NAME}", toInteger($searchLimit), $queryEmbedding)
       YIELD node, similarity
       MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(node)
       WHERE similarity >= $threshold
       WITH node, similarity
       ORDER BY similarity DESC
       LIMIT toInteger($searchLimit)
       MATCH (node)-[r]->(target:Entity)
       WHERE NOT type(r) IN ['HAS_ENTITY', 'HAS_MEMORY', 'CREATED_BY', 'HAS_CATEGORY', 'HAS_APP', 'SUPERSEDES', 'MENTIONS', 'ACCESSED']
       MATCH (u2:User {userId: $userId})-[:HAS_ENTITY]->(target)
       RETURN node.name AS source, type(r) AS relationship, target.name AS target, similarity
       UNION
       CALL vector_search.search("${ENTITY_INDEX_NAME}", toInteger($searchLimit), $queryEmbedding)
       YIELD node, similarity
       MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(node)
       WHERE similarity >= $threshold
       WITH node, similarity
       ORDER BY similarity DESC
       LIMIT toInteger($searchLimit)
       MATCH (source:Entity)-[r]->(node)
       WHERE NOT type(r) IN ['HAS_ENTITY', 'HAS_MEMORY', 'CREATED_BY', 'HAS_CATEGORY', 'HAS_APP', 'SUPERSEDES', 'MENTIONS', 'ACCESSED']
       MATCH (u3:User {userId: $userId})-[:HAS_ENTITY]->(source)
       RETURN source.name AS source, type(r) AS relationship, node.name AS target, similarity
       ORDER BY similarity DESC
       LIMIT toInteger($resultLimit)`,
      {
        queryEmbedding,
        userId,
        threshold,
        searchLimit: limit * 2,
        resultLimit: limit,
      },
    );

    // Deduplicate triples
    const seen = new Set<string>();
    const triples: RelationTriple[] = [];
    for (const r of rows) {
      const key = `${r.source}|${r.relationship}|${r.target}`;
      if (!seen.has(key)) {
        seen.add(key);
        triples.push({
          source: r.source,
          relationship: r.relationship,
          target: r.target,
          score: r.similarity,
        });
      }
    }
    return triples.slice(0, limit);
  }

  async upsertRelationship(
    input: UpsertRelationshipInput,
    embedding: { source: number[]; target: number[] },
    userId: string,
  ): Promise<GraphEdge> {
    const sourceType = (input.sourceType ?? "ENTITY").toUpperCase();
    const targetType = (input.targetType ?? "ENTITY").toUpperCase();
    const rel = input.relationship.toUpperCase().replace(/\s+/g, "_");
    const props = input.properties ? JSON.stringify(input.properties) : "{}";
    const now = new Date().toISOString();
    const srcName = normalizeName(input.sourceName);
    const tgtName = normalizeName(input.targetName);
    const srcNormalized = srcName.replace(/[\s\-_./\\]+/g, "");
    const tgtNormalized = tgtName.replace(/[\s\-_./\\]+/g, "");

    // Ensure User node exists
    await runWrite(
      `MERGE (u:User {userId: $userId})
       ON CREATE SET u.createdAt = $now`,
      { userId, now },
    );

    // MERGE source entity + HAS_ENTITY edge
    const srcRows = await runWrite<{ srcId: string }>(
      `MATCH (u:User {userId: $userId})
       MERGE (u)-[:HAS_ENTITY]->(src:Entity {normalizedName: $srcNormalized, userId: $userId})
       ON CREATE SET src.id = $srcId, src.name = $srcName, src.type = $srcType,
                     src.embedding = $srcEmb, src.createdAt = $now, src.updatedAt = $now,
                     src.description = ''
       ON MATCH SET src.embedding = $srcEmb, src.updatedAt = $now
       RETURN src.id AS srcId`,
      {
        userId,
        srcNormalized,
        srcId: generateId(),
        srcName,
        srcType: sourceType,
        srcEmb: embedding.source,
        now,
      },
    );

    // MERGE target entity + HAS_ENTITY edge
    const tgtRows = await runWrite<{ tgtId: string }>(
      `MATCH (u:User {userId: $userId})
       MERGE (u)-[:HAS_ENTITY]->(tgt:Entity {normalizedName: $tgtNormalized, userId: $userId})
       ON CREATE SET tgt.id = $tgtId, tgt.name = $tgtName, tgt.type = $tgtType,
                     tgt.embedding = $tgtEmb, tgt.createdAt = $now, tgt.updatedAt = $now,
                     tgt.description = ''
       ON MATCH SET tgt.embedding = $tgtEmb, tgt.updatedAt = $now
       RETURN tgt.id AS tgtId`,
      {
        userId,
        tgtNormalized,
        tgtId: generateId(),
        tgtName,
        tgtType: targetType,
        tgtEmb: embedding.target,
        now,
      },
    );

    // MERGE the dynamic relationship between the two entities
    // Dynamic relationship types require string interpolation in Cypher
    const relId = generateId();
    await runWrite(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(src:Entity {normalizedName: $srcNormalized, userId: $userId})
       MATCH (u)-[:HAS_ENTITY]->(tgt:Entity {normalizedName: $tgtNormalized, userId: $userId})
       MERGE (src)-[r:${rel}]->(tgt)
       ON CREATE SET r.id = $relId, r.createdAt = $now, r.properties = $props
       ON MATCH SET r.updatedAt = $now, r.properties = $props`,
      { userId, srcNormalized, tgtNormalized, relId, now, props },
    );

    return {
      id: relId,
      sourceId: srcRows[0]?.srcId ?? "",
      sourceName: srcName,
      relationship: rel,
      targetId: tgtRows[0]?.tgtId ?? "",
      targetName: tgtName,
      properties: input.properties ?? {},
    };
  }

  async deleteRelationship(
    sourceName: string,
    relationship: string,
    targetName: string,
    userId: string,
  ): Promise<void> {
    const rel = relationship.toUpperCase().replace(/\s+/g, "_");
    const srcNormalized = normalizeName(sourceName).replace(/[\s\-_./\\]+/g, "");
    const tgtNormalized = normalizeName(targetName).replace(/[\s\-_./\\]+/g, "");

    await runWrite(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(src:Entity {normalizedName: $srcNormalized, userId: $userId})
       MATCH (u)-[:HAS_ENTITY]->(tgt:Entity {normalizedName: $tgtNormalized, userId: $userId})
       MATCH (src)-[r:${rel}]->(tgt)
       DELETE r`,
      { userId, srcNormalized, tgtNormalized },
    );
  }

  // â”€â”€ Traversal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async getNeighborhood(
    nodeId: string,
    userId: string,
    options: TraversalOptions = {},
  ): Promise<Subgraph> {
    const depth = options.depth ?? 1;
    const limit = options.limit ?? 50;

    const relFilter =
      options.relationshipTypes && options.relationshipTypes.length > 0
        ? `:${options.relationshipTypes.join("|")}`
        : "";

    // Exclude internal MemForge relationship types from traversal
    const rows = await runRead<{
      neighborNodes: Array<{ id: string; name: string; type?: string; description?: string }>;
      edgeList: Array<{ id: string; srcId: string; srcName: string; relType: string | null; tgtId: string; tgtName: string; properties?: string }>;
    }>(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(center:Entity {id: $nodeId})
       CALL {
         WITH center
         MATCH path = (center)-[${relFilter}*1..${depth}]-(neighbor:Entity)
         WHERE ALL(r IN relationships(path) WHERE NOT type(r) IN ['HAS_ENTITY', 'HAS_MEMORY', 'CREATED_BY', 'HAS_CATEGORY', 'HAS_APP', 'SUPERSEDES', 'MENTIONS', 'ACCESSED'])
         UNWIND relationships(path) AS rel
         WITH DISTINCT
           startNode(rel) AS src, rel, endNode(rel) AS tgt,
           neighbor
         RETURN
           collect(DISTINCT {
             id: neighbor.id, name: neighbor.name, type: neighbor.type,
             description: coalesce(neighbor.description, '')
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
      { nodeId, userId, limit },
    );

    if (rows.length === 0) {
      return { nodes: [], edges: [] };
    }

    const rec = rows[0];
    const rawNodes = rec.neighborNodes ?? [];
    const rawEdges = rec.edgeList ?? [];

    const nodes: GraphNode[] = rawNodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type ?? undefined,
      properties: { description: n.description ?? "" },
    }));

    const edges: GraphEdge[] = rawEdges
      .filter((e) => e.relType != null)
      .map((e) => ({
        id: e.id,
        sourceId: e.srcId,
        sourceName: e.srcName,
        relationship: e.relType as string,
        targetId: e.tgtId,
        targetName: e.tgtName,
        properties: e.properties ? JSON.parse(e.properties) : {},
      }));

    return { nodes, edges };
  }

  async getSubgraph(
    nodeId: string,
    userId: string,
    options: TraversalOptions = {},
  ): Promise<Subgraph> {
    const depth = options.depth ?? 1;
    const limit = options.limit ?? 50;

    const relFilter =
      options.relationshipTypes && options.relationshipTypes.length > 0
        ? `:${options.relationshipTypes.join("|")}`
        : "";

    const rows = await runRead<{
      subNodes: Array<{ id: string; name: string; type?: string; description?: string }>;
      subEdges: Array<{ id: string; srcId: string; srcName: string; relType: string | null; tgtId: string; tgtName: string; properties?: string }>;
    }>(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(center:Entity {id: $nodeId})
       OPTIONAL MATCH path = (center)-[${relFilter}*1..${depth}]-(neighbor:Entity)
       WHERE ALL(r IN relationships(path) WHERE NOT type(r) IN ['HAS_ENTITY', 'HAS_MEMORY', 'CREATED_BY', 'HAS_CATEGORY', 'HAS_APP', 'SUPERSEDES', 'MENTIONS', 'ACCESSED'])
       WITH center, collect(DISTINCT neighbor) AS neighbors
       WITH center, neighbors, [center] + neighbors AS allNodes
       UNWIND allNodes AS n
       WITH DISTINCT n, allNodes
       OPTIONAL MATCH (n)-[r]->(m)
       WHERE m IN allNodes
         AND NOT type(r) IN ['HAS_ENTITY', 'HAS_MEMORY', 'CREATED_BY', 'HAS_CATEGORY', 'HAS_APP', 'SUPERSEDES', 'MENTIONS', 'ACCESSED']
       RETURN
         collect(DISTINCT {
           id: n.id, name: n.name, type: n.type,
           description: COALESCE(n.description, '')
         }) AS subNodes,
         collect(DISTINCT {
           id: COALESCE(r.id, toString(id(r))),
           srcId: n.id, srcName: n.name,
           relType: type(r),
           tgtId: m.id, tgtName: m.name,
           properties: COALESCE(r.properties, '{}')
         }) AS subEdges
       LIMIT toInteger($limit)`,
      { nodeId, userId, limit },
    );

    if (rows.length === 0) {
      return { nodes: [], edges: [] };
    }

    const rec = rows[0];
    const rawNodes = rec.subNodes ?? [];
    const rawEdges = rec.subEdges ?? [];

    const nodes: GraphNode[] = rawNodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type ?? undefined,
      properties: { description: n.description ?? "" },
    }));

    const edges: GraphEdge[] = rawEdges
      .filter((e) => e.relType != null)
      .map((e) => ({
        id: e.id,
        sourceId: e.srcId,
        sourceName: e.srcName,
        relationship: e.relType as string,
        targetId: e.tgtId,
        targetName: e.tgtName,
        properties: e.properties ? JSON.parse(e.properties) : {},
      }));

    return { nodes, edges };
  }

  // â”€â”€ Bulk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async getAll(userId: string, limit: number = 100): Promise<RelationTriple[]> {
    const rows = await runRead<{
      source: string;
      relationship: string;
      target: string;
    }>(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(src:Entity)
       MATCH (src)-[r]->(tgt:Entity)
       WHERE NOT type(r) IN ['HAS_ENTITY', 'HAS_MEMORY', 'CREATED_BY', 'HAS_CATEGORY', 'HAS_APP', 'SUPERSEDES', 'MENTIONS', 'ACCESSED']
       MATCH (u)-[:HAS_ENTITY]->(tgt)
       RETURN src.name AS source, type(r) AS relationship, tgt.name AS target
       LIMIT toInteger($limit)`,
      { userId, limit },
    );

    return rows.map((r) => ({
      source: r.source,
      relationship: r.relationship,
      target: r.target,
    }));
  }

  async deleteAll(userId: string): Promise<void> {
    // Delete all entities owned by this user (and their incident edges)
    await runWrite(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
       DETACH DELETE e`,
      { userId },
    );
  }
}

/** Singleton instance for the application. */
let _instance: MemgraphGraphStore | null = null;

export function getGraphStore(): MemgraphGraphStore {
  if (!_instance) {
    _instance = new MemgraphGraphStore();
  }
  return _instance;
}
