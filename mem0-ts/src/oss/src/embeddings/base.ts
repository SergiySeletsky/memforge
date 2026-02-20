export type MemoryAction = "add" | "search" | "update";

export interface Embedder {
  embed(text: string, memoryAction?: MemoryAction): Promise<number[]>;
  embedBatch(texts: string[], memoryAction?: MemoryAction): Promise<number[][]>;
}
