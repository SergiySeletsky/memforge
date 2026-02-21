/**
 * Auto-categorization — port of openmemory/api/app/utils/categorization.py
 *
 * Uses OpenAI (or Azure OpenAI) to classify memory content into categories.
 * Best-effort: silently returns [] on failure.
 */
import OpenAI, { AzureOpenAI } from "openai";
import { MEMORY_CATEGORIZATION_PROMPT } from "./prompts";

let _openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    const azureKey = process.env.LLM_AZURE_OPENAI_API_KEY;
    const azureEndpoint = process.env.LLM_AZURE_ENDPOINT;
    const azureApiVersion = process.env.LLM_AZURE_API_VERSION || "2025-01-01-preview";

    if (azureKey && azureEndpoint) {
      _openaiClient = new AzureOpenAI({
        apiKey: azureKey,
        endpoint: azureEndpoint,
        apiVersion: azureApiVersion,
      });
    } else {
      _openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL || undefined,
      });
    }
  }
  return _openaiClient;
}

function getCategorizationModel(): string {
  return (
    process.env.OPENMEMORY_CATEGORIZATION_MODEL ||
    process.env.LLM_AZURE_DEPLOYMENT ||
    process.env.OPENAI_CHAT_MODEL ||
    "gpt-4o-mini"
  );
}

/**
 * Get categories for a memory string. Retries up to 3 times with exponential backoff.
 * Returns empty array on failure (best-effort).
 */
export async function getCategoriesForMemory(memory: string): Promise<string[]> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = getOpenAIClient();
      const completion = await client.chat.completions.create({
        model: getCategorizationModel(),
        messages: [
          { role: "system", content: MEMORY_CATEGORIZATION_PROMPT },
          {
            role: "user",
            content: `Return ONLY valid JSON with shape: {"categories": ["..."]}. Do not include extra keys or any prose.\n\nMemory:\n${memory}`,
          },
        ],
        temperature: 0,
      });

      const raw = (completion.choices[0]?.message?.content || "").trim();
      const data = JSON.parse(raw);
      const cats = typeof data === "object" && data !== null ? data.categories : null;

      if (!Array.isArray(cats)) return [];
      return cats
        .map((c: unknown) => String(c).trim().toLowerCase())
        .filter((c: string) => c.length > 0);
    } catch (e) {
      console.error(`[ERROR] Failed to get categories (attempt ${attempt}):`, e);
      if (attempt < maxAttempts) {
        // Exponential backoff: 4s, 8s
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
      }
    }
  }

  return [];
}
