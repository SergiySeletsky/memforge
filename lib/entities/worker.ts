/**
 * lib/entities/worker.ts — Async entity & relationship extraction orchestrator
 *
 * Fire-and-forget worker. Do NOT await this from hot-path code.
 *
 * Pipeline (GraphRAG-inspired combined extraction):
 *   1. Read memory content + check extractionStatus (skip if 'done')
 *   2. Resolve userId via graph traversal
 *   3. Set extractionStatus = 'pending'
 *   4. extractEntitiesAndRelationships() → { entities, relationships }
 *      - Single LLM call extracts both entities AND relationships
 *      - Optional gleaning (multi-pass) catches missed entities
 *   5. resolveEntity() for each → entity id (MERGE find-or-create)
 *   6. linkMemoryToEntity() for each → [:MENTIONS] edge
 *   7. linkEntities() for each relationship → [:RELATED_TO] edge
 *   8. summarizeEntityDescription() for entities with existing descriptions
 *   9. Set extractionStatus = 'done'
 *   On error: set extractionStatus = 'failed', store error message
 */
import { runRead, runWrite } from "@/lib/db/memgraph";
import { extractEntitiesAndRelationships } from "./extract";
import { resolveEntity } from "./resolve";
import { linkMemoryToEntity } from "./link";
import { linkEntities } from "./relate";
import { summarizeEntityDescription } from "./summarize-description";
import { generateEntitySummary, getEntityMentionCount, SUMMARY_THRESHOLD } from "./summarize-entity";

/** Local copy — avoids dependency on resolve.ts being mocked in tests. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_./\\]+/g, "");
}

export async function processEntityExtraction(memoryId: string): Promise<void> {
  // Step 1: fetch memory content and current extraction status
  const check = await runRead<{ status: string | null; content: string }>(
    `MATCH (m:Memory {id: $memoryId}) RETURN m.extractionStatus AS status, m.content AS content`,
    { memoryId }
  );
  if (!check.length) return; // memory not found — silently skip

  const { status, content } = check[0];
  if (status === "done") return; // idempotent — already processed

  // Step 2: resolve the owner userId via the graph
  const ctx = await runRead<{ userId: string }>(
    `MATCH (u:User)-[:HAS_MEMORY]->(m:Memory {id: $memoryId}) RETURN u.userId AS userId`,
    { memoryId }
  );
  if (!ctx.length) return;
  const userId = ctx[0].userId;

  // Step 3: mark as pending / increment attempt counter
  await runWrite(
    `MATCH (m:Memory {id: $memoryId})
     SET m.extractionStatus = 'pending',
         m.extractionAttempts = coalesce(m.extractionAttempts, 0) + 1`,
    { memoryId }
  );

  try {
    // Step 4a: Fetch recent user memories for co-reference context (P3)
    const recentRows = await runRead<{ content: string }>(
      `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
       WHERE m.id <> $memoryId AND m.invalidAt IS NULL
       RETURN m.content AS content
       ORDER BY m.createdAt DESC
       LIMIT 3`,
      { userId, memoryId }
    ).catch(() => []);
    const previousMemories = recentRows.map((r) => r.content);

    // Step 4b: Combined LLM extraction (entities + relationships)
    const { entities: extracted, relationships } =
      await extractEntitiesAndRelationships(content as string, { previousMemories });

    // ENTITY-01: Tier 1 batch — look up all normalizedNames in one UNWIND round-trip.
    const validEntities = extracted.filter((e) => e.name?.trim());

    let tier1Map = new Map<string, string>();
    if (validEntities.length > 0) {
      const normNames = validEntities.map((e) => normalizeName(e.name));
      const tier1Rows = await runRead<{ normName: string; entityId: string }>(
        `UNWIND $normNames AS normName
         MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
         WHERE e.normalizedName = normName
         RETURN normName, e.id AS entityId`,
        { normNames, userId }
      ).catch(() => []);
      for (const row of tier1Rows) {
        if (!tier1Map.has(row.normName)) tier1Map.set(row.normName, row.entityId);
      }
    }

    // Steps 5 & 6: resolve + link each entity, build name→id map for relationships
    const entityNameToId = new Map<string, string>();
    for (const entity of validEntities) {
      const normName = normalizeName(entity.name);
      const entityId = tier1Map.has(normName)
        ? tier1Map.get(normName)!
        : await resolveEntity(entity, userId);
      await linkMemoryToEntity(memoryId, entityId);
      entityNameToId.set(entity.name.toLowerCase(), entityId);
    }

    // Step 7: Create [:RELATED_TO] edges between resolved entities
    //         Pass entity names for temporal contradiction LLM prompt context
    //         Pass metadata for domain-specific attributes on edges
    for (const rel of relationships) {
      const sourceId = entityNameToId.get(rel.source.toLowerCase());
      const targetId = entityNameToId.get(rel.target.toLowerCase());
      if (sourceId && targetId && sourceId !== targetId) {
        await linkEntities(sourceId, targetId, rel.type, rel.description, rel.source, rel.target, rel.metadata);
      }
    }

    // Step 8: Fire-and-forget description summarization for entities that had
    // existing descriptions (Tier 1 hits = already existed before this memory)
    for (const entity of validEntities) {
      const normName = normalizeName(entity.name);
      if (tier1Map.has(normName) && entity.description) {
        summarizeEntityDescription(
          tier1Map.get(normName)!,
          entity.name,
          entity.description
        ).catch((err: unknown) =>
          console.warn("[worker] descriptionSummarize failed:", err)
        );
      }
    }

    // Step 9: Entity profile summary for entities that have accumulated enough
    // context (≥ SUMMARY_THRESHOLD connected memories).
    // Only for Tier 1 hits — new entities can't have enough mentions yet.
    // Best-effort: failures logged but never block the pipeline.
    for (const entity of validEntities) {
      const normName = normalizeName(entity.name);
      if (tier1Map.has(normName)) {
        const entityId = tier1Map.get(normName)!;
        try {
          const count = await getEntityMentionCount(entityId);
          if (count >= SUMMARY_THRESHOLD) {
            generateEntitySummary(entityId).catch((err: unknown) =>
              console.warn("[worker] entitySummary failed:", err)
            );
          }
        } catch (err: unknown) {
          console.warn("[worker] mentionCount failed:", err);
        }
      }
    }

    // Step 10: mark done
    await runWrite(
      `MATCH (m:Memory {id: $memoryId}) SET m.extractionStatus = 'done'`,
      { memoryId }
    );
  } catch (e: unknown) {
    await runWrite(
      `MATCH (m:Memory {id: $memoryId})
       SET m.extractionStatus = 'failed', m.extractionError = $error`,
      { memoryId, error: e instanceof Error ? e.message : String(e) }
    );
  }
}
