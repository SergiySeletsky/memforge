/**
 * Cohere reranker — uses the Cohere Rerank API.
 * Port of Python mem0.reranker.cohere_reranker.CohereReranker.
 *
 * Requires: npm install cohere-ai
 * The `cohere-ai` package is lazy-imported so it's only needed if this provider is used.
 */
import { Reranker, extractDocText } from "./base";

export interface CohereRerankerConfig {
  /** Cohere API key (falls back to COHERE_API_KEY env) */
  apiKey?: string;
  /** Model (default "rerank-english-v3.0") */
  model?: string;
  /** Maximum results to return (overridden by topK at call site) */
  topK?: number;
  /** Whether to return documents in the response (default false) */
  returnDocuments?: boolean;
  /** Max chunks per document (default undefined) */
  maxChunksPerDoc?: number;
}

export class CohereReranker implements Reranker {
  private client: any;
  private model: string;
  private defaultTopK: number | undefined;
  private returnDocuments: boolean;
  private maxChunksPerDoc: number | undefined;

  constructor(config: CohereRerankerConfig = {}) {
    const apiKey = config.apiKey ?? process.env.COHERE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Cohere API key is required. Set COHERE_API_KEY env or pass apiKey in config.",
      );
    }
    // Lazy import cohere-ai
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CohereClient } = require("cohere-ai");
      this.client = new CohereClient({ token: apiKey });
    } catch {
      throw new Error(
        "cohere-ai package is required for CohereReranker. Install it: npm install cohere-ai",
      );
    }
    this.model = config.model ?? "rerank-english-v3.0";
    this.defaultTopK = config.topK;
    this.returnDocuments = config.returnDocuments ?? false;
    this.maxChunksPerDoc = config.maxChunksPerDoc;
  }

  async rerank(
    query: string,
    documents: Array<Record<string, any>>,
    topK?: number,
  ): Promise<Array<Record<string, any>>> {
    const limit = topK ?? this.defaultTopK ?? documents.length;
    const texts = documents.map(extractDocText);

    try {
      const response = await this.client.rerank({
        model: this.model,
        query,
        documents: texts,
        topN: limit,
        returnDocuments: this.returnDocuments,
        ...(this.maxChunksPerDoc !== undefined && {
          maxChunksPerDoc: this.maxChunksPerDoc,
        }),
      });

      const results: Array<Record<string, any>> = [];
      for (const result of response.results) {
        results.push({
          ...documents[result.index],
          rerank_score: result.relevanceScore,
        });
      }
      return results;
    } catch (e) {
      // Fallback: assign score 0 and return originals
      console.error("Cohere rerank failed, falling back to original order:", e);
      return documents.slice(0, limit).map((doc) => ({
        ...doc,
        rerank_score: 0.0,
      }));
    }
  }
}
