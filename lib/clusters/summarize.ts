/**
 * lib/clusters/summarize.ts â€” Spec 07
 *
 * Given an array of memory content strings from the same cluster,
 * generates a short name and one-sentence summary via LLM.
 * Pure LLM logic â€” no storage dependencies.
 */
import { getLLMClient, resetLLMClient } from "@/lib/ai/client";

/** @internal Test helper â€” reset singleton so mocks take effect. */
export function _resetOpenAIClient(): void {
  resetLLMClient();
}

export async function summarizeCluster(
  memories: string[]
): Promise<{ name: string; summary: string }> {
  const model =
    process.env.LLM_AZURE_DEPLOYMENT ?? process.env.MEMFORGE_CATEGORIZATION_MODEL ?? "gpt-4o-mini";

  // Sample up to 20 memories to stay within token limits
  const sample = memories
    .slice(0, 20)
    .map((m, i) => `${i + 1}. ${m}`)
    .join("\n");

  try {
    const resp = await getLLMClient().chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a memory categorization assistant. Given a list of related memories, produce a short name (3-5 words) and a one-sentence summary that captures the common theme.",
        },
        {
          role: "user",
          content: `Memories:\n${sample}\n\nRespond with JSON: {"name": "...", "summary": "..."}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const content = resp.choices[0]?.message?.content ?? "{}";
    let parsed: { name?: string; summary?: string };
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }

    return {
      name: parsed.name ?? "Memory Community",
      summary: parsed.summary ?? "A collection of related memories.",
    };
  } catch {
    return {
      name: "Memory Community",
      summary: "A collection of related memories.",
    };
  }
}
