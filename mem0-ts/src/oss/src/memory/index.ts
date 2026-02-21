import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";
import {
  MemoryConfig,
  MemoryConfigSchema,
  MemoryItem,
  Message,
  SearchFilters,
  SearchResult,
} from "../types";
import {
  EmbedderFactory,
  LLMFactory,
  VectorStoreFactory,
  HistoryManagerFactory,
  RerankerFactory,
} from "../utils/factory";
import {
  getFactRetrievalMessages,
  getUpdateMemoryMessages,
  parseMessages,
  removeCodeBlocks,
} from "../prompts";
import { DummyHistoryManager } from "../storage/DummyHistoryManager";
import { Embedder } from "../embeddings/base";
import { LLM } from "../llms/base";
import { VectorStore } from "../vector_stores/base";
import { Reranker } from "../reranker/base";
import { ConfigManager } from "../config/manager";
import { MemoryGraph } from "./graph_memory";
import {
  GraphStore,
  GraphNode,
  GraphEdge,
  RelationTriple,
  Subgraph,
  UpsertRelationshipInput,
  TraversalOptions,
} from "../graph_stores/base";
import { MemgraphGraphStore } from "../graph_stores/memgraph";
import { KuzuGraphStore } from "../graph_stores/kuzu";
import {
  AddMemoryOptions,
  SearchMemoryOptions,
  DeleteAllMemoryOptions,
  GetAllMemoryOptions,
} from "./memory.types";
import { parse_vision_messages } from "../utils/memory";
import { HistoryManager } from "../storage/base";
import { captureClientEvent } from "../utils/telemetry";

const PROCEDURAL_MEMORY_SYSTEM_PROMPT = `You are a memory summarization system that records and preserves the complete interaction history between a human and an AI agent. You are provided with the agent's execution history over the past N steps. Your task is to produce a comprehensive summary of the agent's output history that contains every detail necessary for the agent to continue the task without ambiguity. **Every output produced by the agent must be recorded verbatim as part of the summary.**

### Overall Structure:
- **Overview (Global Metadata):**
  - **Task Objective**: The overall goal the agent is working to accomplish.
  - **Progress Status**: The current completion percentage and summary of specific milestones or steps completed.

- **Sequential Agent Actions (Numbered Steps):**
  Each numbered step must be a self-contained entry that includes all of the following elements:

  1. **Agent Action**: Precisely describe what the agent did (e.g., "Clicked on the 'Blog' link", "Called API to fetch content", "Scraped page data"). Include all parameters, target elements, or methods involved.

  2. **Action Result (Mandatory, Unmodified)**: Immediately follow the agent action with its exact, unaltered output. Record all returned data, responses, HTML snippets, JSON content, or error messages exactly as received.

  3. **Embedded Metadata**: For the same numbered step, include additional context such as:
     - **Key Findings**: Any important information discovered.
     - **Navigation History**: For browser agents, detail which pages were visited, including URLs.
     - **Errors & Challenges**: Document any error messages, exceptions, or challenges.
     - **Current Context**: Describe the state after the action and what the agent plans to do next.

### Guidelines:
1. **Preserve Every Output**: The exact output of each agent action is essential. Do not paraphrase or summarize the output. It must be stored as is for later use.
2. **Chronological Order**: Number the agent actions sequentially in the order they occurred.
3. **Detail and Precision**: Use exact data: Include URLs, element indexes, error messages, JSON responses, and any other concrete values. Preserve numeric counts and metrics. For any errors, include the full error message.
4. **Output Only the Summary**: The final output must consist solely of the structured summary with no additional commentary or preamble.`;

export class Memory {
  private config: MemoryConfig;
  private customPrompt: string | undefined;
  private customUpdateMemoryPrompt: string | undefined;
  private embedder: Embedder;
  private vectorStore: VectorStore;
  private llm: LLM;
  private db: HistoryManager;
  private collectionName: string | undefined;
  private apiVersion: string;
  private graphMemory?: MemoryGraph;
  private graphNativeStore?: GraphStore;
  private enableGraph: boolean;
  private reranker?: Reranker;
  telemetryId: string;

  constructor(config: Partial<MemoryConfig> = {}) {
    // Merge and validate config
    this.config = ConfigManager.mergeConfig(config);

    this.customPrompt = this.config.customPrompt;
    this.customUpdateMemoryPrompt = this.config.customUpdateMemoryPrompt;
    this.embedder = EmbedderFactory.create(
      this.config.embedder.provider,
      this.config.embedder.config,
    );
    this.vectorStore = VectorStoreFactory.create(
      this.config.vectorStore.provider,
      this.config.vectorStore.config,
    );
    this.llm = LLMFactory.create(
      this.config.llm.provider,
      this.config.llm.config,
    );
    if (this.config.disableHistory) {
      this.db = new DummyHistoryManager();
    } else {
      const defaultConfig = {
        provider: "memgraph",
        config: {
          url: process.env.MEMGRAPH_URL || "bolt://localhost:7687",
          username: process.env.MEMGRAPH_USER || "memgraph",
          password: process.env.MEMGRAPH_PASSWORD || "memgraph",
        },
      };

      this.db =
        this.config.historyStore && !this.config.disableHistory
          ? HistoryManagerFactory.create(
              this.config.historyStore.provider,
              this.config.historyStore,
            )
          : HistoryManagerFactory.create("memgraph", defaultConfig);
    }

    this.collectionName = this.config.vectorStore.config.collectionName;
    this.apiVersion = this.config.version || "v1.0";
    this.enableGraph = this.config.enableGraph || false;
    this.telemetryId = "anonymous";

    // Initialize graph memory if configured
    if (this.enableGraph && this.config.graphStore) {
      const gProvider = this.config.graphStore.provider.toLowerCase();
      if (gProvider === "memgraph") {
        this.graphNativeStore = new MemgraphGraphStore({
          url: this.config.graphStore.config.url,
          username: this.config.graphStore.config.username,
          password: this.config.graphStore.config.password,
          dimension: this.config.embedder.config.embeddingDims,
        });
      } else if (gProvider === "kuzu") {
        this.graphNativeStore = new KuzuGraphStore({
          dbPath: (this.config.graphStore.config as any).dbPath,
          dimension: this.config.embedder.config.embeddingDims,
        });
      } else {
        // Legacy "neo4j" provider — uses the existing MemoryGraph class
        this.graphMemory = new MemoryGraph(this.config);
      }
    }

    // Initialize reranker if configured
    if (this.config.reranker) {
      this.reranker = RerankerFactory.create(
        this.config.reranker.provider,
        this.config.reranker.config ?? {},
      );
    }

    // Initialize telemetry if vector store is initialized
    this._initializeTelemetry();
  }

  private async _initializeTelemetry() {
    try {
      await this._getTelemetryId();

      // Capture initialization event
      await captureClientEvent("init", this, {
        api_version: this.apiVersion,
        client_type: "Memory",
        collection_name: this.collectionName,
        enable_graph: this.enableGraph,
      });
    } catch {
      /* telemetry errors are intentionally swallowed to never block writes */
    }
  }

  private async _getTelemetryId() {
    try {
      if (
        !this.telemetryId ||
        this.telemetryId === "anonymous"
      ) {
        this.telemetryId = await this.vectorStore.getUserId();
      }
      return this.telemetryId;
    } catch (error) {
      this.telemetryId = "anonymous";
      return this.telemetryId;
    }
  }

  private async _captureEvent(methodName: string, additionalData = {}) {
    try {
      await this._getTelemetryId();
      await captureClientEvent(methodName, this, {
        ...additionalData,
        api_version: this.apiVersion,
        collection_name: this.collectionName,
      });
    } catch (error) {
      console.error(`Failed to capture ${methodName} event:`, error);
    }
  }

  /**
   * Detect if memory extraction should use agent-focused prompts.
   * Returns true when agentId is set AND there are assistant messages.
   */
  private _isAgentMemory(
    messages: Message[],
    metadata: Record<string, any>,
  ): boolean {
    if (!metadata.agentId) return false;
    return messages.some((m) => m.role === "assistant");
  }

  static fromConfig(configDict: Record<string, any>): Memory {
    try {
      const config = MemoryConfigSchema.parse(configDict);
      return new Memory(config);
    } catch (e) {
      console.error("Configuration validation error:", e);
      throw e;
    }
  }

  async add(
    messages: string | Message[],
    config: AddMemoryOptions,
  ): Promise<SearchResult> {
    await this._captureEvent("add", {
      message_count: Array.isArray(messages) ? messages.length : 1,
      has_metadata: !!config.metadata,
      has_filters: !!config.filters,
      infer: config.infer,
    });
    const {
      userId,
      agentId,
      runId,
      metadata = {},
      filters = {},
      infer = true,
    } = config;

    if (userId) filters.userId = metadata.userId = userId;
    if (agentId) filters.agentId = metadata.agentId = agentId;
    if (runId) filters.runId = metadata.runId = runId;

    if (!filters.userId && !filters.agentId && !filters.runId) {
      throw new Error(
        "One of the filters: userId, agentId or runId is required!",
      );
    }

    const parsedMessages = Array.isArray(messages)
      ? (messages as Message[])
      : [{ role: "user", content: messages }];

    const final_parsedMessages = await parse_vision_messages(parsedMessages);

    // Procedural memory: skip fact extraction, store a single summarized memory
    if (
      agentId &&
      config.memoryType === "procedural_memory"
    ) {
      return this._createProceduralMemory(
        final_parsedMessages,
        metadata,
        config.prompt,
      );
    }

    // Add to vector store
    const vectorStoreResult = await this.addToVectorStore(
      final_parsedMessages,
      metadata,
      filters,
      infer,
    );

    // Add to graph store if available
    let graphResult;
    if (this.graphMemory) {
      try {
        graphResult = await this.graphMemory.add(
          final_parsedMessages.map((m) => m.content).join("\n"),
          filters,
        );
      } catch (error) {
        console.error("Error adding to graph memory:", error);
      }
    }

    return {
      results: vectorStoreResult,
      relations: graphResult?.relations,
    };
  }

  /**
   * Create a procedural memory — summarises agent interaction history
   * into a single memory entry without fact extraction / dedup.
   * Port of Python _create_procedural_memory.
   */
  private async _createProceduralMemory(
    messages: Message[],
    metadata: Record<string, any>,
    customPrompt?: string,
  ): Promise<SearchResult> {
    const systemPrompt =
      customPrompt ?? PROCEDURAL_MEMORY_SYSTEM_PROMPT;

    const llmMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
      {
        role: "user",
        content: "Create procedural memory of the above conversation.",
      },
    ];

    const rawResponse = await this.llm.generateResponse(llmMessages);
    const proceduralMemory = removeCodeBlocks(
      typeof rawResponse === "string" ? rawResponse : rawResponse.content,
    );

    metadata.memory_type = "procedural_memory";
    const embedding = await this.embedder.embed(proceduralMemory, "add");
    const memoryId = await this.createMemory(
      proceduralMemory,
      { [proceduralMemory]: embedding },
      metadata,
    );

    return {
      results: [
        {
          id: memoryId,
          memory: proceduralMemory,
          metadata: { event: "ADD" },
        },
      ],
    };
  }

  private async addToVectorStore(
    messages: Message[],
    metadata: Record<string, any>,
    filters: SearchFilters,
    infer: boolean,
  ): Promise<MemoryItem[]> {
    if (!infer) {
      const returnedMemories: MemoryItem[] = [];
      for (const message of messages) {
        if (message.content === "system") {
          continue;
        }
        const memoryId = await this.createMemory(
          message.content as string,
          {},
          metadata,
        );
        returnedMemories.push({
          id: memoryId,
          memory: message.content as string,
          metadata: { event: "ADD" },
        });
      }
      return returnedMemories;
    }
    const parsedMessages = messages.map((m) => m.content).join("\n");

    const isAgentMem = this._isAgentMemory(messages, metadata);

    const [systemPrompt, userPrompt] = this.customPrompt
      ? [
          this.customPrompt.toLowerCase().includes("json")
            ? this.customPrompt
            : `${this.customPrompt}\n\nYou MUST return a valid JSON object with a 'facts' key containing an array of strings.`,
          `Input:\n${parsedMessages}`,
        ]
      : getFactRetrievalMessages(parsedMessages, isAgentMem);

    const response = await this.llm.generateResponse(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { type: "json_object" },
    );

    const cleanResponse = removeCodeBlocks(response as string);
    let facts: string[] = [];
    try {
      facts = JSON.parse(cleanResponse).facts || [];
    } catch (e) {
      console.error(
        "Failed to parse facts from LLM response:",
        cleanResponse,
        e,
      );
      facts = [];
    }

    // Get embeddings for new facts
    const newMessageEmbeddings: Record<string, number[]> = {};
    const retrievedOldMemory: Array<{ id: string; text: string }> = [];

    // Create embeddings and search for similar memories
    for (const fact of facts) {
      const embedding = await this.embedder.embed(fact, "add");
      newMessageEmbeddings[fact] = embedding;

      const existingMemories = await this.vectorStore.search(
        embedding,
        5,
        filters,
      );
      for (const mem of existingMemories) {
        retrievedOldMemory.push({ id: mem.id, text: mem.payload.data });
      }
    }

    // Remove duplicates from old memories
    const uniqueOldMemories = retrievedOldMemory.filter(
      (mem, index) =>
        retrievedOldMemory.findIndex((m) => m.id === mem.id) === index,
    );

    // Create UUID mapping for handling UUID hallucinations
    const tempUuidMapping: Record<string, string> = {};
    uniqueOldMemories.forEach((item, idx) => {
      tempUuidMapping[String(idx)] = item.id;
      uniqueOldMemories[idx].id = String(idx);
    });

    // Get memory update decisions
    const updatePrompt = getUpdateMemoryMessages(uniqueOldMemories, facts, this.customUpdateMemoryPrompt);

    const updateResponse = await this.llm.generateResponse(
      [{ role: "user", content: updatePrompt }],
      { type: "json_object" },
    );

    const cleanUpdateResponse = removeCodeBlocks(updateResponse as string);
    let memoryActions: any[] = [];
    try {
      memoryActions = JSON.parse(cleanUpdateResponse).memory || [];
    } catch (e) {
      console.error(
        "Failed to parse memory actions from LLM response:",
        cleanUpdateResponse,
        e,
      );
      memoryActions = [];
    }

    // Process memory actions
    const results: MemoryItem[] = [];
    for (const action of memoryActions) {
      try {
        switch (action.event) {
          case "ADD": {
            const memoryId = await this.createMemory(
              action.text,
              newMessageEmbeddings,
              metadata,
            );
            results.push({
              id: memoryId,
              memory: action.text,
              metadata: { event: action.event },
            });
            break;
          }
          case "UPDATE": {
            const realMemoryId = tempUuidMapping[action.id];
            await this.updateMemory(
              realMemoryId,
              action.text,
              newMessageEmbeddings,
              metadata,
            );
            results.push({
              id: realMemoryId,
              memory: action.text,
              metadata: {
                event: action.event,
                previousMemory: action.old_memory,
              },
            });
            break;
          }
          case "DELETE": {
            const realMemoryId = tempUuidMapping[action.id];
            await this.deleteMemory(realMemoryId);
            results.push({
              id: realMemoryId,
              memory: action.text,
              metadata: { event: action.event },
            });
            break;
          }
          case "NONE": {
            // Even if content doesn't change, update session IDs if provided
            const realMemoryId = tempUuidMapping[action.id];
            if (realMemoryId && (metadata.agentId || metadata.runId)) {
              const existingMemory = await this.vectorStore.get(realMemoryId);
              if (existingMemory) {
                const updatedMetadata = { ...existingMemory.payload };
                if (metadata.agentId) updatedMetadata.agentId = metadata.agentId;
                if (metadata.runId) updatedMetadata.runId = metadata.runId;
                updatedMetadata.updatedAt = new Date().toISOString();
                await this.vectorStore.update(realMemoryId, null, updatedMetadata);
              }
            }
            break;
          }
        }
      } catch (error) {
        console.error(`Error processing memory action: ${error}`);
      }
    }

    return results;
  }

  async get(memoryId: string): Promise<MemoryItem | null> {
    const memory = await this.vectorStore.get(memoryId);
    if (!memory) return null;

    const filters = {
      ...(memory.payload.userId && { userId: memory.payload.userId }),
      ...(memory.payload.agentId && { agentId: memory.payload.agentId }),
      ...(memory.payload.runId && { runId: memory.payload.runId }),
    };

    const memoryItem: MemoryItem = {
      id: memory.id,
      memory: memory.payload.data,
      hash: memory.payload.hash,
      createdAt: memory.payload.createdAt,
      updatedAt: memory.payload.updatedAt,
      metadata: {},
    };

    // Add additional metadata
    const excludedKeys = new Set([
      "userId",
      "agentId",
      "runId",
      "hash",
      "data",
      "createdAt",
      "updatedAt",
    ]);
    for (const [key, value] of Object.entries(memory.payload)) {
      if (!excludedKeys.has(key)) {
        memoryItem.metadata![key] = value;
      }
    }

    return { ...memoryItem, ...filters };
  }

  async search(
    query: string,
    config: SearchMemoryOptions,
  ): Promise<SearchResult> {
    await this._captureEvent("search", {
      query_length: query.length,
      limit: config.limit,
      has_filters: !!config.filters,
    });
    const { userId, agentId, runId, limit = 100, filters = {}, threshold, rerank = true } = config;

    if (userId) filters.userId = userId;
    if (agentId) filters.agentId = agentId;
    if (runId) filters.runId = runId;

    if (!filters.userId && !filters.agentId && !filters.runId) {
      throw new Error(
        "One of the filters: userId, agentId or runId is required!",
      );
    }

    // Search vector store
    const queryEmbedding = await this.embedder.embed(query, "search");
    const memories = await this.vectorStore.search(
      queryEmbedding,
      limit,
      filters,
    );

    // Search graph store if available
    let graphResults;
    if (this.graphMemory) {
      try {
        graphResults = await this.graphMemory.search(query, filters);
      } catch (error) {
        console.error("Error searching graph memory:", error);
      }
    }

    const excludedKeys = new Set([
      "userId",
      "agentId",
      "runId",
      "hash",
      "data",
      "createdAt",
      "updatedAt",
    ]);
    const results = memories
      .filter((mem) => threshold === undefined || (mem.score !== undefined && mem.score >= threshold))
      .map((mem) => ({
      id: mem.id,
      memory: mem.payload.data,
      hash: mem.payload.hash,
      createdAt: mem.payload.createdAt,
      updatedAt: mem.payload.updatedAt,
      score: mem.score,
      metadata: Object.entries(mem.payload)
        .filter(([key]) => !excludedKeys.has(key))
        .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
      ...(mem.payload.userId && { userId: mem.payload.userId }),
      ...(mem.payload.agentId && { agentId: mem.payload.agentId }),
      ...(mem.payload.runId && { runId: mem.payload.runId }),
    }));

    // Apply reranking if enabled and reranker is available
    let finalResults = results;
    if (rerank && this.reranker && results.length > 0) {
      try {
        finalResults = await this.reranker.rerank(query, results, limit);
      } catch (e) {
        console.warn("Reranking failed, using original results:", e);
      }
    }

    return {
      results: finalResults,
      relations: graphResults,
    };
  }

  async update(memoryId: string, data: string): Promise<{ message: string }> {
    await this._captureEvent("update", { memory_id: memoryId });
    const embedding = await this.embedder.embed(data, "update");
    await this.updateMemory(memoryId, data, { [data]: embedding });
    return { message: "Memory updated successfully!" };
  }

  async delete(memoryId: string): Promise<{ message: string }> {
    await this._captureEvent("delete", { memory_id: memoryId });
    await this.deleteMemory(memoryId);
    return { message: "Memory deleted successfully!" };
  }

  async deleteAll(
    config: DeleteAllMemoryOptions,
  ): Promise<{ message: string }> {
    await this._captureEvent("delete_all", {
      has_user_id: !!config.userId,
      has_agent_id: !!config.agentId,
      has_run_id: !!config.runId,
    });
    const { userId, agentId, runId } = config;

    const filters: SearchFilters = {};
    if (userId) filters.userId = userId;
    if (agentId) filters.agentId = agentId;
    if (runId) filters.runId = runId;

    if (!Object.keys(filters).length) {
      throw new Error(
        "At least one filter is required to delete all memories. If you want to delete all memories, use the `reset()` method.",
      );
    }

    const [memories] = await this.vectorStore.list(filters);
    for (const memory of memories) {
      await this.deleteMemory(memory.id);
    }

    return { message: "Memories deleted successfully!" };
  }

  async history(memoryId: string): Promise<any[]> {
    return this.db.getHistory(memoryId);
  }

  async reset(): Promise<void> {
    await this._captureEvent("reset");
    await this.db.reset();

    // Check provider before attempting deleteCol
    if (this.config.vectorStore.provider.toLowerCase() !== "langchain") {
      try {
        await this.vectorStore.deleteCol();
      } catch (e) {
        console.error(
          `Failed to delete collection for provider '${this.config.vectorStore.provider}':`,
          e,
        );
        // Decide if you want to re-throw or just log
      }
    } else {
      console.warn(
        "Memory.reset(): Skipping vector store collection deletion as 'langchain' provider is used. Underlying Langchain vector store data is not cleared by this operation.",
      );
    }

    if (this.graphMemory) {
      await this.graphMemory.deleteAll({ userId: "default" }); // Assuming this is okay, or needs similar check?
    }

    // Re-initialize factories/clients based on the original config
    this.embedder = EmbedderFactory.create(
      this.config.embedder.provider,
      this.config.embedder.config,
    );
    // Re-create vector store instance - crucial for Langchain to reset wrapper state if needed
    this.vectorStore = VectorStoreFactory.create(
      this.config.vectorStore.provider,
      this.config.vectorStore.config, // This will pass the original client instance back
    );
    this.llm = LLMFactory.create(
      this.config.llm.provider,
      this.config.llm.config,
    );
    // Re-init DB if needed (though db.reset() likely handles its state)
    // Re-init Graph if needed

    // Re-initialize telemetry
    this._initializeTelemetry();
  }

  async getAll(config: GetAllMemoryOptions): Promise<SearchResult> {
    await this._captureEvent("get_all", {
      limit: config.limit,
      has_user_id: !!config.userId,
      has_agent_id: !!config.agentId,
      has_run_id: !!config.runId,
    });
    const { userId, agentId, runId, limit = 100 } = config;

    const filters: SearchFilters = {};
    if (userId) filters.userId = userId;
    if (agentId) filters.agentId = agentId;
    if (runId) filters.runId = runId;

    const [memories] = await this.vectorStore.list(filters, limit);

    const excludedKeys = new Set([
      "userId",
      "agentId",
      "runId",
      "hash",
      "data",
      "createdAt",
      "updatedAt",
    ]);
    const results = memories.map((mem) => ({
      id: mem.id,
      memory: mem.payload.data,
      hash: mem.payload.hash,
      createdAt: mem.payload.createdAt,
      updatedAt: mem.payload.updatedAt,
      metadata: Object.entries(mem.payload)
        .filter(([key]) => !excludedKeys.has(key))
        .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
      ...(mem.payload.userId && { userId: mem.payload.userId }),
      ...(mem.payload.agentId && { agentId: mem.payload.agentId }),
      ...(mem.payload.runId && { runId: mem.payload.runId }),
    }));

    return { results };
  }

  private async createMemory(
    data: string,
    existingEmbeddings: Record<string, number[]>,
    metadata: Record<string, any>,
  ): Promise<string> {
    const memoryId = uuidv4();
    const embedding =
      existingEmbeddings[data] || (await this.embedder.embed(data));

    const memoryMetadata = {
      ...metadata,
      data,
      hash: createHash("md5").update(data).digest("hex"),
      createdAt: new Date().toISOString(),
    };

    await this.vectorStore.insert([embedding], [memoryId], [memoryMetadata]);
    await this.db.addHistory(
      memoryId,
      null,
      data,
      "ADD",
      memoryMetadata.createdAt,
    );

    return memoryId;
  }

  private async updateMemory(
    memoryId: string,
    data: string,
    existingEmbeddings: Record<string, number[]>,
    metadata: Record<string, any> = {},
  ): Promise<string> {
    const existingMemory = await this.vectorStore.get(memoryId);
    if (!existingMemory) {
      throw new Error(`Memory with ID ${memoryId} not found`);
    }

    const prevValue = existingMemory.payload.data;
    const embedding =
      existingEmbeddings[data] || (await this.embedder.embed(data));

    const newMetadata = {
      ...metadata,
      data,
      hash: createHash("md5").update(data).digest("hex"),
      createdAt: existingMemory.payload.createdAt,
      updatedAt: new Date().toISOString(),
      ...(existingMemory.payload.userId && {
        userId: existingMemory.payload.userId,
      }),
      ...(existingMemory.payload.agentId && {
        agentId: existingMemory.payload.agentId,
      }),
      ...(existingMemory.payload.runId && {
        runId: existingMemory.payload.runId,
      }),
    };

    await this.vectorStore.update(memoryId, embedding, newMetadata);
    await this.db.addHistory(
      memoryId,
      prevValue,
      data,
      "UPDATE",
      newMetadata.createdAt,
      newMetadata.updatedAt,
    );

    return memoryId;
  }

  private async deleteMemory(memoryId: string): Promise<string> {
    const existingMemory = await this.vectorStore.get(memoryId);
    if (!existingMemory) {
      throw new Error(`Memory with ID ${memoryId} not found`);
    }

    const prevValue = existingMemory.payload.data;
    await this.vectorStore.delete(memoryId);
    await this.db.addHistory(
      memoryId,
      prevValue,
      null,
      "DELETE",
      undefined,
      undefined,
      1,
    );

    return memoryId;
  }

  // ─── Graph-native API (Graphiti-style) ───────────────────────────────────
  //
  // These methods require `enableGraph: true` with a Memgraph or KuzuDB
  // graphStore provider.  They expose the underlying graph topology:
  // nodes (entities), edges (relationships), neighborhood traversal,
  // and subgraph extraction.

  private ensureGraphStore(): GraphStore {
    if (!this.graphNativeStore) {
      throw new Error(
        "Graph-native operations require enableGraph: true and a " +
          '"memgraph" or "kuzu" graphStore provider in config.',
      );
    }
    return this.graphNativeStore;
  }

  /**
   * Search entity **nodes** by semantic similarity.
   *
   * ```ts
   * const nodes = await memory.searchNodes("TypeScript", { userId: "u1" });
   * // → [{ id, name: "typescript", type: "technology", score: 0.92, ... }]
   * ```
   */
  async searchNodes(
    query: string,
    config: SearchMemoryOptions,
  ): Promise<GraphNode[]> {
    const gs = this.ensureGraphStore();
    const embedding = await this.embedder.embed(query, "search");
    const filters = this.buildFilters(config);
    return gs.searchNodes(embedding, filters, config.limit, config.threshold);
  }

  /**
   * Search **edges** (relationship triples) by semantic similarity on their
   * endpoint entities.
   *
   * ```ts
   * const edges = await memory.searchEdges("programming languages", { userId: "u1" });
   * // → [{ source: "alice", relationship: "USES", target: "typescript", score: 0.89 }]
   * ```
   */
  async searchEdges(
    query: string,
    config: SearchMemoryOptions,
  ): Promise<RelationTriple[]> {
    const gs = this.ensureGraphStore();
    const embedding = await this.embedder.embed(query, "search");
    const filters = this.buildFilters(config);
    return gs.searchEdges(embedding, filters, config.limit, config.threshold);
  }

  /**
   * Return the **neighborhood** of a node — all nodes and edges within N hops.
   *
   * ```ts
   * const { nodes, edges } = await memory.getNeighborhood(nodeId, { userId: "u1" });
   * ```
   */
  async getNeighborhood(
    nodeId: string,
    config: SearchMemoryOptions & TraversalOptions,
  ): Promise<Subgraph> {
    const gs = this.ensureGraphStore();
    const filters = this.buildFilters(config);
    return gs.getNeighborhood(nodeId, filters, {
      depth: config.depth,
      limit: config.limit,
      relationshipTypes: config.relationshipTypes,
    });
  }

  /**
   * Return a **subgraph** (ego-graph) centered on a node — includes edges
   * between neighbors, not just edges to the center.
   *
   * ```ts
   * const subgraph = await memory.getSubgraph(nodeId, { userId: "u1", depth: 2 });
   * ```
   */
  async getSubgraph(
    nodeId: string,
    config: SearchMemoryOptions & TraversalOptions,
  ): Promise<Subgraph> {
    const gs = this.ensureGraphStore();
    const filters = this.buildFilters(config);
    return gs.getSubgraph(nodeId, filters, {
      depth: config.depth,
      limit: config.limit,
      relationshipTypes: config.relationshipTypes,
    });
  }

  /**
   * Upsert a relationship between two entities. Creates nodes if they don't
   * exist; merges the edge if it already does.
   *
   * ```ts
   * const edge = await memory.upsertRelationship({
   *   sourceName: "Alice",
   *   sourceType: "person",
   *   targetName: "TypeScript",
   *   targetType: "technology",
   *   relationship: "USES",
   * }, { userId: "u1" });
   * ```
   */
  async upsertRelationship(
    input: UpsertRelationshipInput,
    config: { userId?: string; agentId?: string; runId?: string },
  ): Promise<GraphEdge> {
    const gs = this.ensureGraphStore();
    const filters = this.buildFilters(config);

    // Embed both entity names for similarity search later
    const [srcEmb, tgtEmb] = await Promise.all([
      this.embedder.embed(input.sourceName),
      this.embedder.embed(input.targetName),
    ]);

    return gs.upsertRelationship(input, { source: srcEmb, target: tgtEmb }, filters);
  }

  /**
   * Delete a specific relationship triple.
   *
   * ```ts
   * await memory.deleteRelationship("Alice", "USES", "TypeScript", { userId: "u1" });
   * ```
   */
  async deleteRelationship(
    sourceName: string,
    relationship: string,
    targetName: string,
    config: { userId?: string; agentId?: string; runId?: string },
  ): Promise<void> {
    const gs = this.ensureGraphStore();
    const filters = this.buildFilters(config);
    return gs.deleteRelationship(sourceName, relationship, targetName, filters);
  }

  /**
   * Get a single entity node by ID from the graph store.
   *
   * ```ts
   * const node = await memory.getGraphNode(nodeId, { userId: "u1" });
   * ```
   */
  async getGraphNode(
    nodeId: string,
    config: { userId?: string; agentId?: string; runId?: string },
  ): Promise<GraphNode | null> {
    const gs = this.ensureGraphStore();
    const filters = this.buildFilters(config);
    return gs.getNode(nodeId, filters);
  }

  /**
   * Delete a single entity node (and its incident edges) by ID.
   *
   * ```ts
   * await memory.deleteGraphNode(nodeId, { userId: "u1" });
   * ```
   */
  async deleteGraphNode(
    nodeId: string,
    config: { userId?: string; agentId?: string; runId?: string },
  ): Promise<void> {
    const gs = this.ensureGraphStore();
    const filters = this.buildFilters(config);
    return gs.deleteNode(nodeId, filters);
  }

  /**
   * Return all relationship triples in the graph store for a user.
   */
  async getAllRelationships(
    config: GetAllMemoryOptions,
  ): Promise<RelationTriple[]> {
    const gs = this.ensureGraphStore();
    const filters = this.buildFilters(config);
    return gs.getAll(filters, config.limit);
  }

  /**
   * Delete all graph data (nodes + edges) for a user.
   */
  async deleteAllGraph(
    config: DeleteAllMemoryOptions,
  ): Promise<void> {
    const gs = this.ensureGraphStore();
    const filters = this.buildFilters(config);
    return gs.deleteAll(filters);
  }

  /** Build SearchFilters from userId/agentId/runId options. */
  private buildFilters(config: {
    userId?: string;
    agentId?: string;
    runId?: string;
  }): SearchFilters {
    const filters: SearchFilters = {};
    if (config.userId) filters.userId = config.userId;
    if (config.agentId) filters.agentId = config.agentId;
    if (config.runId) filters.runId = config.runId;
    return filters;
  }
}
