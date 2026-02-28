/**
 * lib/entities/summarize-description.ts — Entity description consolidation
 *
 * GraphRAG-inspired: when the same entity appears across multiple memories with
 * different descriptions, use LLM to consolidate them into a single comprehensive
 * description rather than just keeping the longest one.
 *
 * Fire-and-forget — failures are logged but never block the write pipeline.
 */
import { runRead, runWrite } from "@/lib/db/memgraph";
import { getLLMClient } from "@/lib/ai/client";
import { ENTITY_DESCRIPTION_SUMMARIZE_PROMPT } from "./prompts";

/**
 * Summarize an entity's description by consolidating an incoming description
 * with the existing one stored in the database.
 *
 * Skips summarization when:
 *   - Entity has no existing description (just writes the new one)
 *   - Existing and incoming descriptions are identical
 *   - Incoming description is empty
 *
 * @param entityId  The entity node ID
 * @param entityName  Display name (used in the prompt for context)
 * @param incomingDescription  The new description from the current memory
 */
export async function summarizeEntityDescription(
  entityId: string,
  entityName: string,
  incomingDescription: string
): Promise<void> {
  if (!incomingDescription.trim()) return;

  // Fetch current description
  const rows = await runRead<{ description: string }>(
    `MATCH (e:Entity {id: $entityId})
     RETURN coalesce(e.description, '') AS description`,
    { entityId }
  );
  const existing = rows[0]?.description ?? "";

  // Nothing to consolidate — just use the incoming one
  if (!existing.trim()) {
    await runWrite(
      `MATCH (e:Entity {id: $entityId})
       SET e.description = $desc, e.updatedAt = $now`,
      { entityId, desc: incomingDescription, now: new Date().toISOString() }
    );
    return;
  }

  // Same content — no-op
  if (existing.trim().toLowerCase() === incomingDescription.trim().toLowerCase()) return;

  // LLM consolidation
  const model =
    process.env.LLM_AZURE_DEPLOYMENT ??
    process.env.MEMFORGE_CATEGORIZATION_MODEL ??
    "gpt-4o-mini";

  const prompt = ENTITY_DESCRIPTION_SUMMARIZE_PROMPT
    .replace("{entityName}", entityName)
    .replace("{descriptionA}", existing)
    .replace("{descriptionB}", incomingDescription);

  const client = getLLMClient();
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: 200,
  });

  const consolidated = (response.choices[0]?.message?.content ?? "").trim();
  if (!consolidated) return;

  await runWrite(
    `MATCH (e:Entity {id: $entityId})
     SET e.description = $desc, e.updatedAt = $now`,
    { entityId, desc: consolidated, now: new Date().toISOString() }
  );
}
