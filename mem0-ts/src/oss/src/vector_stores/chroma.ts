import { VectorStore } from "./base";
import { SearchFilters, VectorStoreConfig, VectorStoreResult } from "../types";

interface ChromaConfig extends VectorStoreConfig {
  collectionName: string;
  embeddingModelDims?: number;
  host?: string;
  port?: number;
  path?: string;
  apiKey?: string;
  tenant?: string;
  url?: string;
}

/**
 * ChromaDB vector store implementation.
 *
 * Lazily imports the `chromadb` npm package so users who don't need Chroma
 * are never forced to install it.
 */
export class ChromaDB implements VectorStore {
  private client: any; // chromadb Client instance
  private collection: any; // chromadb Collection instance
  private readonly collectionName: string;
  private readonly config: ChromaConfig;
  private userId = "";
  private initialized = false;

  constructor(config: ChromaConfig) {
    this.collectionName = config.collectionName || "mem0";
    this.config = config;
    this.initialize().catch(console.error);
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async initialize(): Promise<void> {
    if (this.initialized) return;

    let chromadb: any;
    try {
      // Dynamic import — chromadb is an optional peer dependency
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      chromadb = require("chromadb");
    } catch {
      throw new Error(
        "The 'chromadb' package is required for ChromaDB vector store. " +
          "Install it with: npm install chromadb",
      );
    }

    const { host, port, path: dbPath, apiKey, tenant, url } = this.config;

    if (apiKey && tenant) {
      // ChromaDB Cloud
      this.client = new chromadb.ChromaClient({
        path: url ?? `https://api.trychroma.com`,
        auth: { provider: "token", credentials: apiKey },
        tenant,
        database: "mem0",
      });
    } else if (host || url) {
      // Remote server
      const chromaUrl = url ?? `http://${host}:${port ?? 8000}`;
      this.client = new chromadb.ChromaClient({ path: chromaUrl });
    } else {
      // Local persistent (or ephemeral)
      this.client = new chromadb.ChromaClient({
        path: dbPath ?? "db",
      });
    }

    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
    });

    this.initialized = true;
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  /* ------------------------------------------------------------------ */
  /*  VectorStore interface                                              */
  /* ------------------------------------------------------------------ */

  async insert(
    vectors: number[][],
    ids: string[],
    payloads: Record<string, any>[],
  ): Promise<void> {
    await this.ensureReady();

    // ChromaDB metadata values must be string | number | boolean
    const sanitized = payloads.map(p => this.sanitizeMetadata(p));

    await this.collection.add({
      ids,
      embeddings: vectors,
      metadatas: sanitized,
    });
  }

  async search(
    query: number[],
    limit = 5,
    filters?: SearchFilters,
  ): Promise<VectorStoreResult[]> {
    await this.ensureReady();

    const where = filters ? this.buildWhereClause(filters) : undefined;

    const results = await this.collection.query({
      queryEmbeddings: [query],
      nResults: limit,
      ...(where && Object.keys(where).length > 0 ? { where } : {}),
    });

    return this.parseResults(results);
  }

  async get(vectorId: string): Promise<VectorStoreResult | null> {
    await this.ensureReady();

    const results = await this.collection.get({ ids: [vectorId] });
    const parsed = this.parseResults(results);
    return parsed.length > 0 ? parsed[0] : null;
  }

  async update(
    vectorId: string,
    vector: number[] | null,
    payload: Record<string, any>,
  ): Promise<void> {
    await this.ensureReady();

    const args: Record<string, any> = {
      ids: [vectorId],
      metadatas: [this.sanitizeMetadata(payload)],
    };
    if (vector) {
      args.embeddings = [vector];
    }

    await this.collection.update(args);
  }

  async delete(vectorId: string): Promise<void> {
    await this.ensureReady();
    await this.collection.delete({ ids: [vectorId] });
  }

  async deleteCol(): Promise<void> {
    await this.ensureReady();
    await this.client.deleteCollection({ name: this.collectionName });
  }

  async list(
    filters?: SearchFilters,
    limit = 100,
  ): Promise<[VectorStoreResult[], number]> {
    await this.ensureReady();

    const where = filters ? this.buildWhereClause(filters) : undefined;

    const results = await this.collection.get({
      ...(where && Object.keys(where).length > 0 ? { where } : {}),
      limit,
    });

    const parsed = this.parseResults(results);
    return [parsed, parsed.length];
  }

  async reset(): Promise<void> {
    await this.ensureReady();
    await this.client.deleteCollection({ name: this.collectionName });
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
    });
  }

  async getUserId(): Promise<string> {
    return this.userId;
  }

  async setUserId(userId: string): Promise<void> {
    this.userId = userId;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Parse ChromaDB query/get results into VectorStoreResult[].
   *
   * ChromaDB returns { ids: string[][], distances?: number[][], metadatas: object[][] }
   * for query, or { ids: string[], metadatas: object[] } for get.
   */
  private parseResults(data: Record<string, any>): VectorStoreResult[] {
    let ids: string[] = data.ids ?? [];
    let distances: (number | null)[] = data.distances ?? [];
    let metadatas: (Record<string, any> | null)[] = data.metadatas ?? [];

    // Query results are nested one level deeper
    if (ids.length > 0 && Array.isArray(ids[0])) {
      ids = ids[0];
      distances = (data.distances ?? [[]])[0] ?? [];
      metadatas = (data.metadatas ?? [[]])[0] ?? [];
    }

    const results: VectorStoreResult[] = [];
    for (let i = 0; i < ids.length; i++) {
      results.push({
        id: ids[i],
        score: distances[i] != null ? distances[i] as number : 0,
        payload: (metadatas[i] as Record<string, any>) ?? {},
      });
    }
    return results;
  }

  /**
   * Sanitize metadata so every value is string | number | boolean.
   * ChromaDB rejects null, undefined, objects, and arrays in metadata.
   */
  private sanitizeMetadata(
    payload: Record<string, any>,
  ): Record<string, string | number | boolean> {
    const clean: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        clean[k] = v;
      } else {
        clean[k] = JSON.stringify(v);
      }
    }
    return clean;
  }

  /**
   * Convert generic SearchFilters into ChromaDB where clause.
   *
   * Handles:
   * - Simple equality: { key: value }
   * - Comparison operators: { key: { eq, ne, gt, gte, lt, lte, in, nin } }
   * - Logical $or: { $or: [ ...conditions ] }
   * - Wildcards: skipped (ChromaDB has no wildcard match)
   */
  private buildWhereClause(
    filters: SearchFilters,
  ): Record<string, any> {
    if (!filters || Object.keys(filters).length === 0) return {};

    const processed: Record<string, any>[] = [];

    for (const [key, value] of Object.entries(filters)) {
      if (key === "$or" && Array.isArray(value)) {
        const orConditions: Record<string, any>[] = [];
        for (const cond of value) {
          for (const [sk, sv] of Object.entries(
            cond as Record<string, any>,
          )) {
            const c = this.convertCondition(sk, sv);
            if (c) orConditions.push(c);
          }
        }
        if (orConditions.length > 1) {
          processed.push({ $or: orConditions });
        } else if (orConditions.length === 1) {
          processed.push(orConditions[0]);
        }
        continue;
      }

      if (key === "AND" && Array.isArray(value)) {
        for (const cond of value) {
          for (const [sk, sv] of Object.entries(
            cond as Record<string, any>,
          )) {
            const c = this.convertCondition(sk, sv);
            if (c) processed.push(c);
          }
        }
        continue;
      }

      if (key === "OR" && Array.isArray(value)) {
        const orConditions: Record<string, any>[] = [];
        for (const cond of value) {
          for (const [sk, sv] of Object.entries(
            cond as Record<string, any>,
          )) {
            const c = this.convertCondition(sk, sv);
            if (c) orConditions.push(c);
          }
        }
        if (orConditions.length > 1) {
          processed.push({ $or: orConditions });
        } else if (orConditions.length === 1) {
          processed.push(orConditions[0]);
        }
        continue;
      }

      if (key === "NOT" || key === "$not") {
        // ChromaDB doesn't have direct NOT support — skip
        continue;
      }

      const converted = this.convertCondition(key, value);
      if (converted) processed.push(converted);
    }

    if (processed.length === 0) return {};
    if (processed.length === 1) return processed[0];
    return { $and: processed };
  }

  /**
   * Convert a single filter condition to ChromaDB where format.
   */
  private convertCondition(
    key: string,
    value: any,
  ): Record<string, any> | null {
    if (value === "*") return null; // wildcard — skip

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // Comparison operators: { eq, ne, gt, gte, lt, lte, in, nin }
      const result: Record<string, any> = {};
      for (const [op, val] of Object.entries(value)) {
        const chromaOp = this.mapOperator(op);
        if (chromaOp) {
          result[key] = { [chromaOp]: val };
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    }

    // Simple equality
    return { [key]: { $eq: value } };
  }

  /**
   * Map generic filter operators to ChromaDB $ operators.
   */
  private mapOperator(op: string): string | null {
    const map: Record<string, string> = {
      eq: "$eq",
      ne: "$ne",
      gt: "$gt",
      gte: "$gte",
      lt: "$lt",
      lte: "$lte",
      in: "$in",
      nin: "$nin",
    };
    return map[op] ?? null;
  }
}
