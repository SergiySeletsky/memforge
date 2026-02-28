/**
 * lib/search/rerank.ts â€” Cross-Encoder Reranking â€” Spec 08
 *
 * An optional second-pass reranker that scores each candidate against
 * the user's query using an LLM. More accurate than cosine similarity
 * for "direct usefulness" but adds ~1â€“2s latency.
 *
 * This is opt-in â€” default hybridSearch behavior is unchanged.
 */
import { getLLMClient } from "@/lib/ai/client";
import { Semaphore } from "@/lib/memforge/semaphore";

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface RerankCandidate {
  id: string;
  content: string;
  [key: string]: unknown;
}

export interface RerankResult extends RerankCandidate {
  rerankScore: number; // 0â€“10 LLM score
}

// â”€â”€ Prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const RERANK_PROMPT = `You are a relevance scoring assistant.
Given a user query and a memory statement, score how directly and usefully the memory answers the query.

Score 0â€“10:
- 10: Directly and completely answers the query
- 7â€“9: Highly relevant, addresses the main topic
- 4â€“6: Partially relevant, related topic
- 1â€“3: Tangentially related
- 0: Irrelevant

Respond with ONLY a single integer 0â€“10.`;

// â”€â”€ Implementation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Rerank candidates using LLM cross-encoder scoring.
 * Processes candidates in parallel with a Semaphore to control concurrency.
 * LLM failure for a single candidate is non-fatal â€” that candidate receives score 0.
 */
export async function crossEncoderRerank(
  query: string,
  candidates: RerankCandidate[],
  topN: number = 10,
  concurrency: number = 5
): Promise<RerankResult[]> {
  const client = getLLMClient();
  const model =
    process.env.SEARCH_RERANK_MODEL ??
    process.env.MEMFORGE_CATEGORIZATION_MODEL ??
    "gpt-4o-mini";

  const sem = new Semaphore(concurrency);

  const scored = await Promise.all(
    candidates.map((candidate) =>
      sem.run(async () => {
        try {
          const response = await client.chat.completions.create({
            model,
            messages: [
              { role: "system", content: RERANK_PROMPT },
              {
                role: "user",
                content: `Query: ${query}\n\nMemory: ${candidate.content}`,
              },
            ],
            temperature: 0,
            max_tokens: 5,
          });

          const raw = (
            response.choices[0]?.message?.content ?? "0"
          ).trim();
          const score = Math.min(10, Math.max(0, parseInt(raw, 10) || 0));
          return { ...candidate, rerankScore: score } as RerankResult;
        } catch {
          return { ...candidate, rerankScore: 0 } as RerankResult;
        }
      })
    )
  );

  return scored
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, topN);
}
