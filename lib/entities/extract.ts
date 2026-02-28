/**
 * lib/entities/extract.ts â€” LLM-based entity extraction (Spec 04)
 *
 * Given a memory string, returns a list of named entities with name, type, description.
 * Fails open: any error returns [].
 */
import { getLLMClient } from "@/lib/ai/client";
import { ENTITY_EXTRACTION_PROMPT } from "./prompts";

export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
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
    result.push({ name, type, description });
  }
  return result;
}

export async function extractEntitiesFromMemory(
  content: string
): Promise<ExtractedEntity[]> {
  const model = process.env.LLM_AZURE_DEPLOYMENT ?? process.env.MEMFORGE_CATEGORIZATION_MODEL ?? "gpt-4o-mini";

  try {
    const client = getLLMClient();
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: ENTITY_EXTRACTION_PROMPT },
        { role: "user", content: `Memory: ${content}` },
      ],
      temperature: 0,
      max_tokens: 500,
    });

    const raw = (response.choices[0]?.message?.content ?? "{}").trim();
    const parsed = JSON.parse(raw);
    return normalizeExtractedEntities(parsed.entities);
  } catch (e) {
    console.warn("[entities/extract] failed:", e);
    return [];
  }
}
