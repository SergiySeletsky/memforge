/**
 * lib/dedup/verifyDuplicate.ts â€” Stage 2 LLM verification
 *
 * Given two memory strings, asks an LLM to classify their relationship:
 *   DUPLICATE   â€” same fact, possibly different words
 *   SUPERSEDES  â€” new memory updates or contradicts the existing one
 *   DIFFERENT   â€” genuinely distinct facts (no dedup action needed)
 *
 * Enhanced with few-shot examples adapted from memforge-ts/oss fact-comparison
 * prompt to improve classification accuracy on nuanced cases:
 *   - Paraphrased facts (DUPLICATE, not DIFFERENT)
 *   - Same topic with richer detail (SUPERSEDES, not DUPLICATE)
 *   - Contradictions / preference reversals (SUPERSEDES, not DIFFERENT)
 *   - Genuinely different topics (DIFFERENT, not SUPERSEDES)
 */
import { getLLMClient } from "@/lib/ai/client";

export type VerificationResult = "DUPLICATE" | "SUPERSEDES" | "DIFFERENT";

/**
 * Enhanced verification prompt with few-shot examples for reliable pairwise
 * classification.  Adapted from the oss DEFAULT_UPDATE_MEMORY_PROMPT which
 * uses ADD/UPDATE/DELETE/NONE; mapped to DIFFERENT/SUPERSEDES/SUPERSEDES/DUPLICATE.
 */
export const VERIFY_PROMPT = `You are a memory deduplication assistant.
Given two memory statements from the same user, determine their relationship.

### Categories

- **DUPLICATE**: Both statements express the same fact â€” same meaning, possibly different words. Minor wording changes or paraphrases that do not add or change information.
- **SUPERSEDES**: Statement B updates, enriches, or contradicts Statement A. B is newer, more specific, or reverses the claim in A. When in doubt between DUPLICATE and SUPERSEDES, choose SUPERSEDES if B adds any new detail.
- **DIFFERENT**: The statements express genuinely distinct facts about different topics or attributes.

### Few-Shot Examples

A: "Likes cheese pizza"
B: "Loves cheese pizza"
â†’ DUPLICATE (same preference, minor wording difference)

A: "User likes to play cricket"
B: "Loves to play cricket with friends"
â†’ SUPERSEDES (B adds new detail: "with friends")

A: "I really like cheese pizza"
B: "Loves chicken pizza"
â†’ SUPERSEDES (same topic â€” pizza preference â€” but the specific preference changed)

A: "Loves cheese pizza"
B: "Dislikes cheese pizza"
â†’ SUPERSEDES (direct contradiction â€” preference reversed)

A: "Name is John"
B: "Loves cheese pizza"
â†’ DIFFERENT (unrelated topics: identity vs food preference)

A: "I moved to London"
B: "I live in NYC"
â†’ SUPERSEDES (same topic â€” residence â€” with updated location)

A: "I prefer dark mode"
B: "Dark theme is my preference"
â†’ DUPLICATE (identical meaning)

### Instructions

Respond with exactly one word: DUPLICATE, SUPERSEDES, or DIFFERENT.`;

/**
 * LLM verification of whether two memory strings represent the same fact.
 * Returns DIFFERENT as a safe fallback for unknown LLM output.
 */
export async function verifyDuplicate(
  newMemory: string,
  existingMemory: string
): Promise<VerificationResult> {
  const client = getLLMClient();
  const model = process.env.LLM_AZURE_DEPLOYMENT ?? process.env.MEMFORGE_CATEGORIZATION_MODEL ?? "gpt-4o-mini";

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: VERIFY_PROMPT },
      {
        role: "user",
        content: `Statement A (existing): ${existingMemory}\n\nStatement B (new): ${newMemory}`,
      },
    ],
    temperature: 0,
    max_tokens: 10,
  });

  const answer = (response.choices[0]?.message?.content ?? "DIFFERENT")
    .trim()
    .toUpperCase();

  if (answer === "DUPLICATE") return "DUPLICATE";
  if (answer === "SUPERSEDES") return "SUPERSEDES";
  return "DIFFERENT";
}
