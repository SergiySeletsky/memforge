/**
 * lib/entities/extract.ts — LLM-based entity & relationship extraction (Spec 04)
 *
 * Combined extraction (GraphRAG-inspired): extracts entities AND relationships
 * in a single LLM call. Optional gleaning (multi-pass) catches entities the
 * LLM missed on the first pass.
 *
 * Fails open: any error returns { entities: [], relationships: [] }.
 */
import { getLLMClient } from "@/lib/ai/client";
import { ENTITY_EXTRACTION_PROMPT, GLEANING_PROMPT } from "./prompts";

export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
  /** Domain-specific structured properties (e.g. dosage, ticker, frequency). */
  metadata?: Record<string, unknown>;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  type: string;
  description: string;
  /** Domain-specific structured properties on the relationship. */
  metadata?: Record<string, unknown>;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

export interface ExtractionOptions {
  /** Recent user memories for co-reference resolution. Injected into the LLM prompt. */
  previousMemories?: string[];
}

function normalizeExtractedEntities(input: unknown): ExtractedEntity[] {
  if (!Array.isArray(input)) return [];
  const result: ExtractedEntity[] = [];
  for (const item of input) {
    const maybe = item as Partial<ExtractedEntity>;
    const name = typeof maybe?.name === "string" ? maybe.name.trim() : "";
    if (!name) continue;
    const type = typeof maybe?.type === "string" && maybe.type.trim()
      ? maybe.type.trim().toUpperCase()
      : "OTHER";
    const description = typeof maybe?.description === "string"
      ? maybe.description.trim()
      : "";
    const metadata = (typeof maybe?.metadata === "object" && maybe.metadata !== null && !Array.isArray(maybe.metadata))
      ? maybe.metadata as Record<string, unknown>
      : undefined;
    result.push({ name, type, description, ...(metadata ? { metadata } : {}) });
  }
  return result;
}

function normalizeExtractedRelationships(input: unknown): ExtractedRelationship[] {
  if (!Array.isArray(input)) return [];
  const result: ExtractedRelationship[] = [];
  for (const item of input) {
    const maybe = item as Partial<ExtractedRelationship>;
    const source = typeof maybe?.source === "string" ? maybe.source.trim() : "";
    const target = typeof maybe?.target === "string" ? maybe.target.trim() : "";
    const type = typeof maybe?.type === "string" ? maybe.type.trim().toUpperCase() : "";
    if (!source || !target || !type) continue;
    const description = typeof maybe?.description === "string"
      ? maybe.description.trim()
      : "";
    const metadata = (typeof maybe?.metadata === "object" && maybe.metadata !== null && !Array.isArray(maybe.metadata))
      ? maybe.metadata as Record<string, unknown>
      : undefined;
    result.push({ source, target, type, description, ...(metadata ? { metadata } : {}) });
  }
  return result;
}

/** Max gleaning passes. 0 = single-pass only. Controlled by env var. */
function getMaxGleanings(): number {
  const env = process.env.MEMFORGE_MAX_GLEANINGS;
  if (env === undefined) return 1; // default: 1 gleaning pass
  const n = parseInt(env, 10);
  return isNaN(n) ? 1 : Math.max(0, Math.min(n, 3)); // cap at 3
}

const PREVIOUS_CONTEXT_LIMIT = 3;

/** Build a context prefix from previous memories for co-reference resolution. */
function buildPreviousContextBlock(memories: string[]): string {
  if (!memories.length) return "";
  const items = memories.slice(0, PREVIOUS_CONTEXT_LIMIT);
  return `\n\n[Previous memories for co-reference context — DO NOT extract entities from these, only use them to resolve pronouns and references in the current memory]\n${items.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n`;
}

/**
 * Extract entities from a memory string (backward-compatible wrapper).
 * Returns only entities — used by callers that don't need relationships.
 */
export async function extractEntitiesFromMemory(
  content: string,
  options?: ExtractionOptions
): Promise<ExtractedEntity[]> {
  const result = await extractEntitiesAndRelationships(content, options);
  return result.entities;
}

/**
 * Full extraction: entities + relationships with optional gleaning.
 * When previousMemories are provided, they are injected into the prompt
 * to help the LLM resolve pronouns and co-references across memories.
 */
export async function extractEntitiesAndRelationships(
  content: string,
  options?: ExtractionOptions
): Promise<ExtractionResult> {
  const model = process.env.LLM_AZURE_DEPLOYMENT ?? process.env.MEMFORGE_CATEGORIZATION_MODEL ?? "gpt-4o-mini";

  try {
    const client = getLLMClient();

    // --- Pass 1: Primary extraction ---
    const contextBlock = buildPreviousContextBlock(options?.previousMemories ?? []);
    const userMessage = `Memory: ${content}${contextBlock}`;

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: ENTITY_EXTRACTION_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: 800,
    });

    const raw = (response.choices[0]?.message?.content ?? "{}").trim();
    const parsed = JSON.parse(raw);
    const entities = normalizeExtractedEntities(parsed.entities);
    const relationships = normalizeExtractedRelationships(parsed.relationships);

    // --- Gleaning passes (GraphRAG-inspired) ---
    const maxGleanings = getMaxGleanings();
    for (let i = 0; i < maxGleanings; i++) {
      try {
        const entityNames = entities.map((e) => e.name).join(", ");
        const gleanPrompt = GLEANING_PROMPT.replace(
          "{previousEntities}",
          entityNames || "(none)"
        );

        const gleanResponse = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: ENTITY_EXTRACTION_PROMPT },
            { role: "user", content: `Memory: ${content}` },
            { role: "assistant", content: raw },
            { role: "user", content: gleanPrompt },
          ],
          temperature: 0,
          max_tokens: 800,
        });

        const gleanRaw = (gleanResponse.choices[0]?.message?.content ?? "{}").trim();
        const gleanParsed = JSON.parse(gleanRaw);
        const newEntities = normalizeExtractedEntities(gleanParsed.entities);
        const newRelationships = normalizeExtractedRelationships(gleanParsed.relationships);

        // No new items found — stop gleaning early
        if (newEntities.length === 0 && newRelationships.length === 0) break;

        // Deduplicate by name (case-insensitive)
        const existingNames = new Set(entities.map((e) => e.name.toLowerCase()));
        for (const e of newEntities) {
          if (!existingNames.has(e.name.toLowerCase())) {
            entities.push(e);
            existingNames.add(e.name.toLowerCase());
          }
        }

        // Deduplicate relationships by (source, target, type) triple
        const existingTriples = new Set(
          relationships.map((r) => `${r.source.toLowerCase()}|${r.target.toLowerCase()}|${r.type}`)
        );
        for (const r of newRelationships) {
          const key = `${r.source.toLowerCase()}|${r.target.toLowerCase()}|${r.type}`;
          if (!existingTriples.has(key)) {
            relationships.push(r);
            existingTriples.add(key);
          }
        }
      } catch {
        // Gleaning failure is non-fatal — keep what we have
        break;
      }
    }

    return { entities, relationships };
  } catch (e) {
    console.warn("[entities/extract] failed:", e);
    return { entities: [], relationships: [] };
  }
}
