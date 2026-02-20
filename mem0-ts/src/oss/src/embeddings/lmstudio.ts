import OpenAI from "openai";
import { Embedder, MemoryAction } from "./base";
import { EmbeddingConfig } from "../types";

/**
 * LM Studio embedder — uses the OpenAI-compatible local API served by LM Studio.
 *
 * Default base URL: http://localhost:1234/v1
 * Default model: nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.f16.gguf
 */
export class LMStudioEmbedder implements Embedder {
  private openai: OpenAI;
  private model: string;
  embeddingDims: number;

  constructor(config: EmbeddingConfig) {
    const baseUrl =
      (config as any).lmstudioBaseUrl ??
      (config as any).baseUrl ??
      process.env.LMSTUDIO_BASE_URL ??
      "http://localhost:1234/v1";

    this.openai = new OpenAI({
      apiKey: config.apiKey || "lm-studio",
      baseURL: baseUrl,
    });
    this.model =
      config.model ||
      "nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.f16.gguf";
    this.embeddingDims = config.embeddingDims || 1536;
  }

  async embed(text: string, _memoryAction?: MemoryAction): Promise<number[]> {
    const cleaned = text.replace(/\n/g, " ");
    const response = await this.openai.embeddings.create({
      model: this.model,
      input: [cleaned],
    });
    return response.data[0].embedding;
  }

  async embedBatch(
    texts: string[],
    _memoryAction?: MemoryAction,
  ): Promise<number[][]> {
    const cleaned = texts.map((t) => t.replace(/\n/g, " "));
    const response = await this.openai.embeddings.create({
      model: this.model,
      input: cleaned,
    });
    return response.data.map((item) => item.embedding);
  }
}
