/**
 * lib/entities/relate.ts — Create/update [:RELATED_TO] edges between Entity nodes
 *
 * Inspired by GraphRAG's relationship extraction approach: entities and their
 * relationships are extracted in a single LLM call, then relationships are
 * resolved here against already-resolved entity IDs.
 *
 * Idempotent via MERGE — re-running for the same (sourceId, targetId, type)
 * triple updates the description if the new one is longer.
 */
import { runWrite } from "@/lib/db/memgraph";

export interface ExtractedRelationship {
  source: string;
  target: string;
  type: string;
  description: string;
}

/**
 * Create or update a [:RELATED_TO] edge between two Entity nodes.
 * The `type` is stored as a property (not a separate edge label) to allow
 * flexible querying without schema constraints.
 *
 * On conflict (same source+target+type): keeps the longer description.
 */
export async function linkEntities(
  sourceEntityId: string,
  targetEntityId: string,
  relType: string,
  description: string = ""
): Promise<void> {
  await runWrite(
    `MATCH (src:Entity {id: $sourceId})
     MATCH (tgt:Entity {id: $targetId})
     MERGE (src)-[r:RELATED_TO {type: $relType}]->(tgt)
     ON CREATE SET r.description = $desc,
                   r.createdAt = $now,
                   r.updatedAt = $now
     ON MATCH SET  r.description = CASE
                     WHEN size(coalesce(r.description, '')) < size($desc)
                     THEN $desc ELSE r.description END,
                   r.updatedAt = $now
     RETURN r`,
    {
      sourceId: sourceEntityId,
      targetId: targetEntityId,
      relType: relType.toUpperCase().replace(/\s+/g, "_"),
      desc: description,
      now: new Date().toISOString(),
    }
  );
}
