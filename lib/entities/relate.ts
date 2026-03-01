/**
 * lib/entities/relate.ts — Create/update [:RELATED_TO] edges between Entity nodes
 *
 * Inspired by GraphRAG's relationship extraction + Graphiti's temporal contradiction
 * detection: when a new fact contradicts an existing relationship, the old edge is
 * invalidated (invalidAt set) and a new edge is created — preserving the full
 * relationship history (bi-temporal edges).
 *
 * Pipeline:
 *   1. Fast-path dedup: if (source, target, type) exists with identical normalized
 *      description, skip entirely (P2 — no DB write needed)
 *   2. If descriptions differ: LLM classifies → SAME | UPDATE | CONTRADICTION
 *      - SAME → no-op
 *      - UPDATE → invalidate old edge, create new edge
 *      - CONTRADICTION → invalidate old edge, create new edge
 *   3. If no existing edge → create with validAt timestamp
 */
import { runRead, runWrite } from "@/lib/db/memgraph";
import { getLLMClient } from "@/lib/ai/client";
import { EDGE_CONTRADICTION_PROMPT } from "./prompts";
import { serializeMetadata, parseMetadata, mergeMetadata } from "./resolve";

export interface ExtractedRelationship {
  source: string;
  target: string;
  type: string;
  description: string;
}

export type EdgeVerdict = "SAME" | "UPDATE" | "CONTRADICTION";

/** Normalize description for fast-path comparison (lowercase, collapse whitespace, trim). */
function normalizeDesc(desc: string): string {
  return desc.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Classify whether a new description contradicts, updates, or repeats an existing one.
 * Fail-open: any LLM error → "UPDATE" (safe default — preserves both versions).
 */
export async function classifyEdgeContradiction(
  oldDescription: string,
  newDescription: string,
  relType: string,
  sourceName: string,
  targetName: string
): Promise<EdgeVerdict> {
  try {
    const model =
      process.env.LLM_AZURE_DEPLOYMENT ??
      process.env.MEMFORGE_CATEGORIZATION_MODEL ??
      "gpt-4o-mini";
    const client = getLLMClient();

    const prompt = EDGE_CONTRADICTION_PROMPT
      .replace("{oldDescription}", oldDescription)
      .replace("{newDescription}", newDescription)
      .replace("{relType}", relType)
      .replace("{sourceName}", sourceName)
      .replace("{targetName}", targetName);

    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 50,
    });

    const raw = (response.choices[0]?.message?.content ?? "").trim();
    const parsed = JSON.parse(raw);
    const verdict = (parsed.verdict ?? "").toUpperCase();

    if (verdict === "SAME" || verdict === "UPDATE" || verdict === "CONTRADICTION") {
      return verdict;
    }
    return "UPDATE"; // unrecognised → safe default
  } catch {
    return "UPDATE"; // fail-open
  }
}

/**
 * Create or update a [:RELATED_TO] edge between two Entity nodes.
 * The `type` is stored as a property (not a separate edge label) to allow
 * flexible querying without schema constraints.
 *
 * Temporal behavior:
 *   - New edge: created with validAt, no invalidAt
 *   - Same description (normalized): skipped entirely (fast-path dedup)
 *   - LLM says SAME: no change
 *   - LLM says UPDATE or CONTRADICTION: old edge invalidated, new edge created
 *
 * @param sourceName  Display name of source entity (for LLM prompt context)
 * @param targetName  Display name of target entity (for LLM prompt context)
 */
export async function linkEntities(
  sourceEntityId: string,
  targetEntityId: string,
  relType: string,
  description: string = "",
  sourceName: string = "",
  targetName: string = "",
  metadata?: Record<string, unknown>
): Promise<void> {
  const normalizedRelType = relType.toUpperCase().replace(/\s+/g, "_");
  const now = new Date().toISOString();

  // Step 1: Check for existing live edge (no invalidAt)
  const existing = await runRead<{ desc: string; metadata: string | null }>(
    `MATCH (src:Entity {id: $sourceId})-[r:RELATED_TO {type: $relType}]->(tgt:Entity {id: $targetId})
     WHERE r.invalidAt IS NULL
     RETURN coalesce(r.description, '') AS desc, r.metadata AS metadata`,
    { sourceId: sourceEntityId, targetId: targetEntityId, relType: normalizedRelType }
  );

  // Merge incoming metadata with existing edge metadata (for replacement edges)
  const existingEdgeMeta = existing.length > 0 ? parseMetadata(existing[0].metadata) : {};
  const mergedMeta = serializeMetadata(mergeMetadata(existingEdgeMeta, metadata));

  if (existing.length > 0) {
    const oldDesc = existing[0].desc;

    // P2 Fast-path: identical normalized description → skip entirely
    if (normalizeDesc(oldDesc) === normalizeDesc(description)) {
      return;
    }

    // Both descriptions non-empty → LLM classification
    if (oldDesc.trim() && description.trim()) {
      const verdict = await classifyEdgeContradiction(
        oldDesc,
        description,
        normalizedRelType,
        sourceName,
        targetName
      );

      if (verdict === "SAME") {
        return; // no change needed
      }

      // UPDATE or CONTRADICTION → invalidate old, create new
      await runWrite(
        `MATCH (src:Entity {id: $sourceId})-[r:RELATED_TO {type: $relType}]->(tgt:Entity {id: $targetId})
         WHERE r.invalidAt IS NULL
         SET r.invalidAt = $now`,
        { sourceId: sourceEntityId, targetId: targetEntityId, relType: normalizedRelType, now }
      );
    } else {
      // Old was empty but new has content → invalidate old, create new with content
      await runWrite(
        `MATCH (src:Entity {id: $sourceId})-[r:RELATED_TO {type: $relType}]->(tgt:Entity {id: $targetId})
         WHERE r.invalidAt IS NULL
         SET r.invalidAt = $now`,
        { sourceId: sourceEntityId, targetId: targetEntityId, relType: normalizedRelType, now }
      );
    }
  }

  // Step 2: Create new edge (either fresh or replacement for invalidated one)
  await runWrite(
    `MATCH (src:Entity {id: $sourceId})
     MATCH (tgt:Entity {id: $targetId})
     CREATE (src)-[r:RELATED_TO {
       type: $relType,
       description: $desc,
       metadata: $metadata,
       validAt: $now,
       createdAt: $now,
       updatedAt: $now
     }]->(tgt)
     RETURN r`,
    {
      sourceId: sourceEntityId,
      targetId: targetEntityId,
      relType: normalizedRelType,
      desc: description,
      metadata: mergedMeta,
      now,
    }
  );
}
