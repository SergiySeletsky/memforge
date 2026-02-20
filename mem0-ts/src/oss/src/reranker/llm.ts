/**
 * LLM-based reranker — uses any LLM to score document relevance 0.0–1.0.
 * Port of Python mem0.reranker.llm_reranker.LLMReranker.
 */
import { Reranker, extractDocText } from "./base";
import { LLM } from "../llms/base";
import { LLMFactory } from "../utils/factory";
import { LLMConfig } from "../types";

export interface LLMRerankerConfig {
  /** LLM provider name (default "openai") */
  provider?: string;
  /** Model to use (default "gpt-4o-mini") */
  model?: string;
  /** API key for the LLM provider */
  apiKey?: string;
  /** Temperature for scoring (default 0) */
  temperature?: number;
  /** Max tokens for the scoring response (default 100) */
  maxTokens?: number;
  /** Custom scoring prompt (use {query} and {document} placeholders) */
  scoringPrompt?: string;
  /** Maximum number of results to return (default: all) */
  topK?: number;
}

const DEFAULT_SCORING_PROMPT = `On a scale from 0.0 to 1.0, rate how relevant the following document is to the given query.
Consider semantic meaning, not just keyword matching.
Respond with ONLY a number between 0.0 and 1.0, nothing else.

Query: {query}

Document: {document}

Relevance score:`;

export class LLMReranker implements Reranker {
  private llm: LLM;
  private scoringPrompt: string;
  private topK: number | undefined;

  constructor(config: LLMRerankerConfig = {}) {
    const provider = config.provider ?? "openai";
    const llmConfig: LLMConfig = {
      apiKey: config.apiKey,
      model: config.model ?? "gpt-4o-mini",
    };
    this.llm = LLMFactory.create(provider, llmConfig);
    this.scoringPrompt = config.scoringPrompt ?? DEFAULT_SCORING_PROMPT;
    this.topK = config.topK;
  }

  async rerank(
    query: string,
    documents: Array<Record<string, any>>,
    topK?: number,
  ): Promise<Array<Record<string, any>>> {
    const limit = topK ?? this.topK;
    const scored: Array<Record<string, any>> = [];

    for (const doc of documents) {
      const text = extractDocText(doc);
      const prompt = this.scoringPrompt
        .replace("{query}", query)
        .replace("{document}", text);

      let score = 0.5; // fallback
      try {
        const response = await this.llm.generateResponse([
          { role: "user", content: prompt },
        ]);
        score = this._extractScore(
          typeof response === "string" ? response : response.content,
        );
      } catch {
        // keep fallback score
      }
      scored.push({ ...doc, rerank_score: score });
    }

    scored.sort((a, b) => b.rerank_score - a.rerank_score);
    return limit !== undefined ? scored.slice(0, limit) : scored;
  }

  /** Extract a float score from LLM text, clamped to [0,1]. */
  private _extractScore(text: string): number {
    const match = text.match(/([0-9]*\.?[0-9]+)/);
    if (!match) return 0.5;
    const val = parseFloat(match[1]);
    if (isNaN(val)) return 0.5;
    return Math.max(0, Math.min(1, val));
  }
}
