/**
 * Base reranker interface.
 * Rerankers re-score search results based on query relevance.
 */
export interface Reranker {
  /**
   * Rerank documents based on relevance to the query.
   *
   * @param query  The search query
   * @param documents  List of documents with at least a `memory` field
   * @param topK  Max results to return (undefined = return all)
   * @returns  Documents with added `rerank_score`, sorted descending
   */
  rerank(
    query: string,
    documents: Array<Record<string, any>>,
    topK?: number,
  ): Promise<Array<Record<string, any>>>;
}

/** Helper to extract text from a document object (tries memory → text → content) */
export function extractDocText(doc: Record<string, any>): string {
  return (
    doc.memory ?? doc.text ?? doc.content ?? JSON.stringify(doc)
  );
}
