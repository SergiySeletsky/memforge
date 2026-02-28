/**
 * lib/memory/categorize.ts
 *
 * LLM-based memory categorization: given a memory text, assign 1-3 category
 * labels and write (Memory)-[:HAS_CATEGORY]->(Category) edges to Memgraph.
 *
 * Called fire-and-forget from addMemory(); errors are swallowed so they never
 * block the write pipeline.
 */
import { runWrite } from "@/lib/db/memgraph";
import { getLLMClient } from "@/lib/ai/client";

const CATEGORIES = [
  "Personal",
  "Work",
  "Health",
  "Finance",
  "Travel",
  "Education",
  "Entertainment",
  "Food",
  "Technology",
  "Sports",
  "Social",
  "Shopping",
  "Family",
  "Goals",
  "Preferences",
] as const;

const SYSTEM_PROMPT = `You are a memory categorization assistant.
Given a memory text, assign 1-3 relevant categories from this list:
${CATEGORIES.join(", ")}.
Respond with ONLY a valid JSON array of category name strings, e.g. ["Personal", "Work"].
Do not include any other text.`;

/**
 * Determine categories for a memory text via LLM and persist them to Memgraph.
 * This function is designed to be called fire-and-forget; it never throws.
 */
export async function categorizeMemory(
  memoryId: string,
  text: string
): Promise<void> {
  try {
    const client = getLLMClient();
    const model =
      process.env.LLM_AZURE_DEPLOYMENT ??
      process.env.MEMFORGE_CATEGORIZATION_MODEL ??
      "gpt-4o-mini";

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Memory: ${text}` },
      ],
      temperature: 0,
      max_tokens: 100,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "[]";
    let categories: string[] = [];
    try {
      categories = JSON.parse(raw);
    } catch {
      // Try to extract JSON array from the response if it contains extra text
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) categories = JSON.parse(match[0]);
    }

    if (!Array.isArray(categories)) return;

    const valid = categories.filter((c) =>
      (CATEGORIES as readonly string[]).includes(c)
    );

    if (valid.length === 0) return;

    // Single UNWIND write â€” avoids N sequential round-trips (was: for-loop await runWrite)
    await runWrite(
      `MATCH (m:Memory {id: $memId})
       UNWIND $names AS name
       MERGE (c:Category {name: name})
       MERGE (m)-[:HAS_CATEGORY]->(c)`,
      { memId: memoryId, names: valid }
    );
  } catch (e) {
    console.warn("[categorize] failed for memory", memoryId, e);
  }
}
