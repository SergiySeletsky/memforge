/**
 * lib/entities/resolve.ts â€” Entity resolution / find-or-create (Spec 04)
 *
 * Uses Cypher to atomically find or create an Entity node for the user.
 * Entities are matched by normalizedName (lowercased + stripped punctuation/spaces)
 * to prevent fragmentation when the LLM uses slightly different name forms
 * (e.g. "OrderService" vs "Order Service" vs "order-service").
 *
 * Three-tier resolution:
 *   1. normalizedName exact match (e.g. "orderservice")
 *   2. PERSON alias match (prefix/suffix word-boundary, e.g. "Alice" â†” "Alice Chen")
 *   3. Semantic dedup â€” embed name+description and cosine-match against existing
 *      entities, then confirm via LLM before merging (threshold: 0.88)
 *
 * Type upgrade rules (open ontology):
 *   - OTHER (rank 99) is the lowest â€” always upgradeable from it.
 *   - CONCEPT (rank 6) upgrades from OTHER only.
 *   - Domain-specific types (not in TYPE_PRIORITY; rank 5) beat CONCEPT but
 *     lose to PERSON / ORGANIZATION / LOCATION / PRODUCT.
 *   - When merging, the most informative (lowest rank) type wins.
 */
import { runRead, runWrite } from "@/lib/db/memgraph";
import { embed } from "@/lib/embeddings/openai";
import { getLLMClient } from "@/lib/ai/client";
import { buildEntityMergePrompt } from "./prompts";
import { generateId } from "@/lib/id";
import type { ExtractedEntity } from "./extract";

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise an entity name for deduplication purposes.
 * "Order Service", "OrderService", "order-service", "order_service" all
 * normalise to "orderservice".
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_./\\]+/g, "");
}

// ---------------------------------------------------------------------------
// Type priority (open ontology)
// ---------------------------------------------------------------------------

/**
 * Explicit priority for the 6 well-known base types plus space for domain types.
 * Domain-specific types (NOT listed here) fall back to DOMAIN_TYPE_DEFAULT_RANK,
 * which places them BETWEEN PRODUCT and CONCEPT â€” i.e. more specific than CONCEPT
 * but less specific than PERSON / ORGANIZATION / LOCATION / PRODUCT.
 */
const TYPE_PRIORITY: Record<string, number> = {
  PERSON: 1,
  ORGANIZATION: 2,
  LOCATION: 3,
  PRODUCT: 4,
  // Domain-specific types default to rank 5 (inserted here dynamically)
  CONCEPT: 6,
  OTHER: 99,
};

const DOMAIN_TYPE_DEFAULT_RANK = 5;

function getTypeRank(type: string): number {
  return TYPE_PRIORITY[type] ?? DOMAIN_TYPE_DEFAULT_RANK;
}

function isMoreSpecific(newType: string, existingType: string): boolean {
  if (newType === existingType) return false;
  return getTypeRank(newType) < getTypeRank(existingType);
}

// ---------------------------------------------------------------------------
// Semantic dedup constants
// ---------------------------------------------------------------------------

const SEMANTIC_DEDUP_THRESHOLD = 0.88;
const SEMANTIC_DEDUP_TOP_K = 5;

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a metadata object to a JSON string for Memgraph storage.
 * Returns '{}' for undefined/null/empty objects.
 */
export function serializeMetadata(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return "{}";
  return JSON.stringify(meta);
}

/**
 * Parse a JSON metadata string from Memgraph. Returns empty object on failure.
 */
export function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Shallow-merge incoming metadata into existing metadata.
 * Newer keys win (overwrite), existing keys not in incoming are preserved.
 * Returns the merged object.
 */
export function mergeMetadata(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!incoming || Object.keys(incoming).length === 0) return existing;
  return { ...existing, ...incoming };
}

// ---------------------------------------------------------------------------
// Semantic entity lookup
// ---------------------------------------------------------------------------

interface EntityCandidate {
  id: string;
  name: string;
  type: string;
  description: string;
  similarity: number;
}

/**
 * Find semantically similar entities in the user's graph using the
 * entity_vectors index, then confirm the best candidate via LLM.
 *
 * Fails silently (returns null) when:
 *   - embed() throws (no API key in tests / dev)
 *   - entity_vectors index doesn't exist yet
 *   - No candidates exceed the similarity threshold
 *   - LLM rejects the merge
 */
async function findEntityBySemantic(
  extracted: ExtractedEntity,
  userId: string
): Promise<EntityCandidate | null> {
  try {
    const embeddingInput = extracted.name + (extracted.description ? ": " + extracted.description : "");
    const embedding = await embed(embeddingInput);

    const candidates = await runRead<EntityCandidate>(
      `CALL vector_search.search("entity_vectors", toInteger($fetchLimit), $embedding)
       YIELD node, similarity
       MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(node)
       WHERE similarity >= $threshold
       RETURN node.id AS id, node.name AS name, node.type AS type,
              coalesce(node.description, '') AS description, similarity
       ORDER BY similarity DESC
       LIMIT $limit`,
      {
        userId,
        fetchLimit: SEMANTIC_DEDUP_TOP_K * 3,
        embedding,
        threshold: SEMANTIC_DEDUP_THRESHOLD,
        limit: SEMANTIC_DEDUP_TOP_K,
      }
    );

    if (candidates.length === 0) return null;

    // Ask the LLM to confirm whether the top candidate is the same entity
    const best = candidates[0];
    const confirmed = await confirmMergeViaLLM(extracted, best);
    return confirmed ? best : null;
  } catch {
    // Graceful degradation â€” embed unavailable or index missing
    return null;
  }
}

/**
 * Ask the LLM whether an incoming entity and an existing candidate refer to
 * the same real-world entity. Returns true only when the LLM says yes.
 */
async function confirmMergeViaLLM(
  incoming: ExtractedEntity,
  existing: EntityCandidate
): Promise<boolean> {
  try {
    const model =
      process.env.LLM_AZURE_DEPLOYMENT ??
      process.env.MEMFORGE_CATEGORIZATION_MODEL ??
      "gpt-4o-mini";
    const client = getLLMClient();
    const prompt = buildEntityMergePrompt(
      { name: incoming.name, type: incoming.type ?? "", description: incoming.description ?? "" },
      { name: existing.name, type: existing.type, description: existing.description }
    );
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 20,
    });
    const raw = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.trim()) as { same: boolean };
    return parsed.same === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Find or create an Entity node scoped to the given user.
 * Returns the entity's id (existing or newly created).
 *
 * Match key: normalizeName(name) + userId (type is NOT part of the match key).
 * On match: upgrades type if new type is more specific, updates description if longer.
 */
export async function resolveEntity(
  extracted: ExtractedEntity,
  userId: string
): Promise<string> {
  const id = generateId();
  const now = new Date().toISOString();
  const normalizedType = (extracted.type ?? "CONCEPT").toUpperCase();
  const normName = normalizeName(extracted.name);

  // Step 1: ensure User node exists
  await runWrite(
    `MERGE (u:User {userId: $userId})
     ON CREATE SET u.createdAt = $now`,
    { userId, now }
  );

  // Step 2: Find existing entity by normalizedName (case+punctuation-insensitive)
  // Read-only lookup â€” use runRead to avoid consuming a write-session slot.
  let existing = await runRead<{
    id: string;
    name: string;
    type: string;
    description: string;
  }>(
    `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
     WHERE e.normalizedName = $normName
     RETURN e.id AS id, e.name AS name, e.type AS type,
            coalesce(e.description, '') AS description
     LIMIT 1`,
    { userId, normName }
  );

  // Step 2b: Name-alias resolution for PERSON entities (Eval v4 Finding 2)
  // If no normalised match and entity is a PERSON, check prefix/suffix word-boundary
  // matches: "Alice" â†” "Alice Chen".
  if (existing.length === 0 && normalizedType === "PERSON") {
    existing = await runRead<{
      id: string;
      name: string;
      type: string;
      description: string;
    }>(
      `MATCH (u:User {userId: $userId})-[:HAS_ENTITY]->(e:Entity)
       WHERE e.type = 'PERSON'
         AND (
           toLower(e.name) STARTS WITH (toLower($name) + ' ')
           OR toLower($name) STARTS WITH (toLower(e.name) + ' ')
         )
       RETURN e.id AS id, e.name AS name, e.type AS type,
              coalesce(e.description, '') AS description
       ORDER BY size(e.name) DESC
       LIMIT 1`,
      { userId, name: extracted.name }
    );

    // Upgrade the stored name to the longer canonical form
    if (existing.length > 0 && extracted.name.length > existing[0].name.length) {
      await runWrite(
        `MATCH (e:Entity {id: $entityId})
         SET e.name = $longerName, e.updatedAt = $now`,
        { entityId: existing[0].id, longerName: extracted.name, now }
      );
      existing[0].name = extracted.name;
    }
  }

  // Step 2c: Semantic dedup â€” embed name+description, vector-search entity_vectors,
  // confirm top match via LLM before merging.  Fails open (no match) when embed is
  // unavailable or the LLM rejects the merge.
  if (existing.length === 0) {
    const semanticMatch = await findEntityBySemantic(extracted, userId);
    if (semanticMatch) {
      existing = [semanticMatch];
    }
  }

  let entityId: string;

  if (existing.length > 0) {
    // Entity exists â€” update type if more specific, description if longer
    entityId = existing[0].id;
    const shouldUpgradeType = isMoreSpecific(normalizedType, existing[0].type);
    const shouldUpgradeDesc =
      (extracted.description ?? "").length > existing[0].description.length;

    // Metadata merge: read current metadata, shallow-merge with incoming
    const hasIncomingMeta = extracted.metadata && Object.keys(extracted.metadata).length > 0;
    const shouldUpdate = shouldUpgradeType || shouldUpgradeDesc || !!hasIncomingMeta;

    if (shouldUpdate) {
      // Read current metadata from the entity node
      let mergedMetaStr = serializeMetadata(extracted.metadata);
      if (hasIncomingMeta) {
        const currentRows = await runRead<{ metadata: string | null }>(
          `MATCH (e:Entity {id: $entityId}) RETURN coalesce(e.metadata, '{}') AS metadata`,
          { entityId }
        );
        const currentMeta = parseMetadata(currentRows[0]?.metadata);
        mergedMetaStr = serializeMetadata(mergeMetadata(currentMeta, extracted.metadata));
      }

      await runWrite(
        `MATCH (e:Entity {id: $entityId})
         SET e.type = CASE WHEN $shouldUpgradeType THEN $newType ELSE e.type END,
             e.description = CASE WHEN $shouldUpgradeDesc THEN $newDesc ELSE e.description END,
             e.metadata = CASE WHEN $hasIncomingMeta THEN $metadata ELSE e.metadata END,
             e.updatedAt = $now`,
        {
          entityId,
          shouldUpgradeType,
          shouldUpgradeDesc,
          hasIncomingMeta: !!hasIncomingMeta,
          newType: normalizedType,
          newDesc: extracted.description ?? "",
          metadata: mergedMetaStr,
          now,
        }
      );
    }
  } else {
    // ENTITY-DUP-FIX: use MERGE on (userId, normalizedName) via the Userâ†’Entity
    // relationship pattern instead of CREATE. Memgraph acquires an exclusive
    // internal lock on the matched edge pattern, so two concurrent callers for
    // the same entity produce exactly one node â€” eliminating the TOCTOU race
    // that produced duplicate Entity nodes during parallel test runs.
    //
    // ON MATCH: no-op â€” this branch only runs when the 3-tier lookup above found
    // nothing, so a concurrent writer beat us here. We get its entity id back.
    const created = await runWrite<{ entityId: string }>(
      `MATCH (u:User {userId: $userId})
       MERGE (u)-[:HAS_ENTITY]->(e:Entity {normalizedName: $normalizedName, userId: $userId})
       ON CREATE SET e.id = $id, e.name = $name, e.type = $type,
                     e.description = $description,
                     e.metadata = $metadata,
                     e.createdAt = $now, e.updatedAt = $now
       RETURN e.id AS entityId`,
      {
        id,
        userId,
        name: extracted.name,
        normalizedName: normName,
        type: normalizedType,
        description: extracted.description ?? "",
        metadata: serializeMetadata(extracted.metadata),
        now,
      }
    );
    // Use the id returned by MERGE â€” may differ from $id if a concurrent writer
    // beat us to the CREATE (in which case we reuse their entity, not ours).
    entityId = created[0]?.entityId ?? id;
  }

  // Fire-and-forget: compute description embedding for future semantic dedup lookups
  const descText = extracted.description ?? extracted.name;
  if (descText) {
    embedDescriptionAsync(entityId, descText).catch((err) =>
      console.warn("[resolveEntity] descriptionEmbedding failed:", err)
    );
  }

  return entityId;
}

/**
 * Embed the entity description and store the vector on the Entity node.
 * Called fire-and-forget â€” failures are logged but do not block the pipeline.
 */
async function embedDescriptionAsync(
  entityId: string,
  text: string
): Promise<void> {
  const vector = await embed(text);
  await runWrite(
    `MATCH (e:Entity {id: $entityId})
     SET e.descriptionEmbedding = $vector`,
    { entityId, vector }
  );
}
