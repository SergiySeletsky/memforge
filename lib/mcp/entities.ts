/**
 * lib/mcp/entities.ts — Entity query & mutation functions for 2-tool MCP
 *
 * Extracted from the former specialized entity tools (search_memory_entities,
 * get_memory_entity, get_related_memories, get_memory_map, delete_memory_entity).
 *
 * search_memory uses searchEntities() to auto-enrich results with entity profiles.
 * add_memories uses invalidateMemoriesByDescription() and deleteEntityByNameOrId()
 * for INVALIDATE and DELETE_ENTITY intents.
 *
 * All Cypher queries anchor through User (Spec 09 — namespace isolation).
 */
import { runRead, runWrite } from "@/lib/db/memgraph";
import { embed } from "@/lib/embeddings/openai";
import { hybridSearch } from "@/lib/search/hybrid";
import { deleteMemory } from "@/lib/memory/write";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityProfile {
  id: string;
  name: string;
  type: string;
  description: string | null;
  memoryCount: number;
  relationships: Array<{
    source: string;
    type: string;
    target: string;
    description: string | null;
  }>;
}

export interface DeleteEntityResult {
  entity: string;
  mentionEdgesRemoved: number;
  relationshipsRemoved: number;
}

// ---------------------------------------------------------------------------
// searchEntities — entity search with substring + semantic arms
// ---------------------------------------------------------------------------

/**
 * Search for entities matching a query (substring + semantic).
 * Used by search_memory to auto-enrich results with entity profiles.
 * Returns entities with their relationship details.
 */
export async function searchEntities(
  query: string,
  userId: string,
  options?: { entityType?: string; limit?: number }
): Promise<EntityProfile[]> {
  const effectiveLimit = options?.limit ?? 5;
  const typeClause = options?.entityType ? "AND e.type = $entityType" : "";
  const params: Record<string, unknown> = {
    userId,
    query: query.toLowerCase(),
    limit: effectiveLimit,
  };
  if (options?.entityType) params.entityType = options.entityType.toUpperCase();

  // Arm 1: Substring match on name/description
  const substringRows = await runRead<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    memoryCount: number;
  }>(
    `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
     WHERE (toLower(e.name) CONTAINS $query
            OR (e.description IS NOT NULL AND toLower(e.description) CONTAINS $query))
           ${typeClause}
     OPTIONAL MATCH (m:Memory)-[:MENTIONS]->(e)
     WHERE m.invalidAt IS NULL
     WITH e, count(m) AS memoryCount
     RETURN e.id AS id, e.name AS name, e.type AS type,
            e.description AS description, memoryCount
     ORDER BY memoryCount DESC
     LIMIT $limit`,
    params,
  );

  // Arm 2: Semantic match — embed query, cosine similarity against entity descriptions
  let semanticRows: typeof substringRows = [];
  try {
    const queryEmbedding = await embed(query);
    const semParams: Record<string, unknown> = {
      userId,
      embedding: queryEmbedding,
      limit: effectiveLimit,
    };
    if (options?.entityType) semParams.entityType = options.entityType.toUpperCase();
    const semTypeClause = options?.entityType ? "AND e.type = $entityType" : "";

    semanticRows = await runRead<{
      id: string;
      name: string;
      type: string;
      description: string | null;
      memoryCount: number;
    }>(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
       WHERE e.descriptionEmbedding IS NOT NULL ${semTypeClause}
       WITH e, vector.similarity.cosine(e.descriptionEmbedding, $embedding) AS similarity
       WHERE similarity > 0.3
       OPTIONAL MATCH (m:Memory)-[:MENTIONS]->(e)
       WHERE m.invalidAt IS NULL
       WITH e, count(m) AS memoryCount, similarity
       ORDER BY similarity DESC
       LIMIT $limit
       RETURN e.id AS id, e.name AS name, e.type AS type,
              e.description AS description, memoryCount`,
      semParams,
    );
  } catch {
    // Semantic arm is best-effort — vector index may not exist on Entity nodes
  }

  // Merge + deduplicate by id
  const seen = new Set<string>();
  const merged: typeof substringRows = [];
  for (const row of [...substringRows, ...semanticRows]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      merged.push(row);
    }
  }

  // ENTITY-ENRICH-N+1 fix: Single UNWIND query replaces per-entity for-loop
  const entityIds = merged.slice(0, effectiveLimit).map((e) => e.id);
  const relRows = entityIds.length > 0
    ? await runRead<{
        entityId: string;
        sourceName: string;
        relType: string;
        targetName: string;
        description: string | null;
      }>(
        `UNWIND $entityIds AS eid
         MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(center:Entity {id: eid})
         OPTIONAL MATCH (center)-[r:RELATED_TO]->(tgt:Entity)<-[:HAS_ENTITY]-(u)
         WITH center, r, tgt, eid
         WHERE r IS NOT NULL
         RETURN eid AS entityId, center.name AS sourceName, r.relType AS relType,
                tgt.name AS targetName, r.description AS description
         UNION ALL
         UNWIND $entityIds AS eid
         MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(center:Entity {id: eid})
         OPTIONAL MATCH (u)-[:HAS_ENTITY]->(src:Entity)-[r:RELATED_TO]->(center)
         WITH center, src, r, eid
         WHERE r IS NOT NULL
         RETURN eid AS entityId, src.name AS sourceName, r.relType AS relType,
                center.name AS targetName, r.description AS description`,
        { userId, entityIds },
      )
    : [];

  // Group relationships by entity ID
  const relMap = new Map<string, EntityProfile["relationships"]>();
  for (const r of relRows) {
    const list = relMap.get(r.entityId) ?? [];
    list.push({
      source: r.sourceName,
      type: r.relType,
      target: r.targetName,
      description: r.description,
    });
    relMap.set(r.entityId, list);
  }

  const results: EntityProfile[] = merged.slice(0, effectiveLimit).map((entity) => ({
    ...entity,
    relationships: relMap.get(entity.id) ?? [],
  }));

  return results;
}

// ---------------------------------------------------------------------------
// invalidateMemoriesByDescription — soft-delete memories matching a description
// ---------------------------------------------------------------------------

/**
 * Find memories matching a natural-language description and soft-delete them.
 * Used by add_memories for the INVALIDATE intent.
 *
 * Uses hybrid search to find matching memories, then applies a relevance
 * threshold to avoid deleting unrelated content. Returns the list of
 * invalidated memories for the response payload.
 */
export async function invalidateMemoriesByDescription(
  description: string,
  userId: string
): Promise<Array<{ id: string; content: string }>> {
  const matches = await hybridSearch(description, {
    userId,
    topK: 10,
    mode: "hybrid",
  });

  if (matches.length === 0) return [];

  // Only invalidate memories with a reasonable relevance score.
  // RRF max theoretical score ≈ 0.0328. Threshold at ~46% of max.
  const RRF_THRESHOLD = 0.015;
  const toInvalidate = matches.filter((m) => m.rrfScore >= RRF_THRESHOLD);

  if (toInvalidate.length === 0) return [];

  const invalidated: Array<{ id: string; content: string }> = [];

  for (const match of toInvalidate) {
    const deleted = await deleteMemory(match.id, userId);
    if (deleted) {
      invalidated.push({ id: match.id, content: match.content });
    }
  }

  return invalidated;
}

// ---------------------------------------------------------------------------
// deleteEntityByNameOrId — remove entity + all connections
// ---------------------------------------------------------------------------

/**
 * Delete an entity by ID or name, removing it and all its relationships.
 * Memories themselves are preserved — only the entity node and its edges are removed.
 * Used by add_memories for the DELETE_ENTITY intent.
 */
export async function deleteEntityByNameOrId(
  userId: string,
  entityId?: string,
  entityName?: string
): Promise<DeleteEntityResult | null> {
  // Resolve entity ID
  let resolvedId = entityId;
  if (!resolvedId && entityName) {
    const found = await runRead<{ id: string }>(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
       WHERE toLower(e.name) = toLower($name)
       RETURN e.id AS id LIMIT 1`,
      { userId, name: entityName },
    );
    if (found.length === 0) return null;
    resolvedId = found[0].id;
  }
  if (!resolvedId) return null;

  // Count relationships that will be lost
  const countRows = await runRead<{
    name: string;
    mentionCount: number;
    relationCount: number;
  }>(
    `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity {id: $entityId})
     OPTIONAL MATCH (m:Memory)-[mention:MENTIONS]->(e)
     WITH e, count(mention) AS mentionCount
     OPTIONAL MATCH (e)-[rel:RELATED_TO]-()
     RETURN e.name AS name, mentionCount, count(rel) AS relationCount`,
    { userId, entityId: resolvedId },
  );

  if (countRows.length === 0 || countRows[0].name == null) return null;

  const { name, mentionCount, relationCount } = countRows[0];

  // Detach delete — removes entity + all its edges
  await runWrite(
    `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity {id: $entityId})
     DETACH DELETE e`,
    { userId, entityId: resolvedId },
  );

  return { entity: name, mentionEdgesRemoved: mentionCount, relationshipsRemoved: relationCount };
}
