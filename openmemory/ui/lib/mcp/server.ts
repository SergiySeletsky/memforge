/**
 * MCP Server for OpenMemory -- 2-tool architecture
 *
 * Two MCP tools provide the complete agentic long-term memory interface:
 *
 *   add_memories   -- write, update, invalidate, or delete entities.
 *                    Accepts a single string or string[]. The server
 *                    auto-classifies intent (STORE / INVALIDATE / DELETE_ENTITY)
 *                    using a fast regex pre-filter + LLM fallback.
 *                    STORE items pass through the existing dedup pipeline
 *                    (INSERT / SKIP_DUPLICATE / SUPERSEDE).
 *
 *   search_memory  -- dual-mode read + knowledge tool.
 *                    query provided  -> hybrid BM25 + vector search, auto-enriched
 *                                      with matching entity profiles & relationships.
 *                    query omitted   -> browse mode: chronological listing with
 *                                      offset/limit pagination and total count.
 *
 * All former specialized tools (update_memory, search_memory_entities,
 * get_memory_entity, get_related_memories, get_memory_map, create_memory_relation,
 * delete_memory_relation, delete_memory_entity) have been absorbed into these two
 * via server-side intent classification and entity-aware search enrichment.
 *
 * Uses @modelcontextprotocol/sdk with SSE transport.
 * Context (user_id, client_name) is passed per-connection via the SSE URL path.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addMemory, supersedeMemory } from "@/lib/memory/write";
import { runRead, runWrite } from "@/lib/db/memgraph";
import { checkDeduplication } from "@/lib/dedup";
import { processEntityExtraction } from "@/lib/entities/worker";
import { classifyIntent } from "@/lib/mcp/classify";
import { searchEntities, invalidateMemoriesByDescription, deleteEntityByNameOrId } from "@/lib/mcp/entities";
import type { EntityProfile } from "@/lib/mcp/entities";
import { hybridSearch } from "@/lib/search/hybrid";

/**
 * Create a new McpServer instance with the 2 memory tools registered.
 * Each request carries userId & clientName via closure.
 */
// Pre-define tool input schemas to avoid TS2589 deep type instantiation
// search_memory is dual-mode -- query is optional:
//   present  -> hybrid BM25 + vector search + entity enrichment
//   absent   -> browse mode (chronological, paginated)
const searchMemorySchema = {
  query: z.string().optional().describe(
    "Natural language search query. " +
    "When provided: hybrid relevance search (BM25 + vector), auto-enriched with matching entity profiles and relationships. " +
    "When omitted: returns all memories in reverse-chronological order with pagination."
  ),
  limit: z.number().optional().describe("Maximum results to return (default: 10 for search, 50 for browse; max: 200)"),
  offset: z.number().optional().describe("Number of memories to skip -- used for paginating browse results (no query). Default: 0"),
  category: z.string().optional().describe("Filter to memories in this category only"),
  created_after: z.string().optional().describe("ISO date -- only return memories created after this date (e.g. '2026-02-01')"),
  include_entities: z.boolean().optional().describe("Include matching entity profiles in search results (default: true for search mode). Set false to skip entity enrichment for faster responses."),
  tag: z.string().optional().describe("Exact tag filter -- returns only memories tagged with this string (case-insensitive). Tags are set via add_memories(tags: [...])."),
};
const addMemoriesSchema = {
  content: z
    .union([z.string(), z.array(z.string())])
    .describe(
      "One or more strings to process. The system auto-classifies each item's intent:\n" +
      "- Facts, preferences, decisions -> stored (with automatic dedup & supersession)\n" +
      "- 'Forget X' / 'Remove memories about Y' -> matching memories are invalidated\n" +
      "- 'Stop tracking entity Z' -> entity and its connections are removed\n" +
      "Pass a single string or an array for batch processing."
    ),
  categories: z
    .array(z.string())
    .optional()
    .describe(
      "Optional explicit category tags for STORE items (e.g. ['Work', 'Architecture']). " +
      "When provided, these categories are written immediately -- the LLM auto-categorizer still " +
      "runs and may add additional categories via MERGE (no duplicates). When omitted, categories are assigned automatically. " +
      "Well-known categories: Personal, Work, Health, Finance, Travel, Education, Entertainment, " +
      "Food, Technology, Sports, Social, Shopping, Family, Goals, Preferences -- but any string is accepted."
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Optional exact-match tags for scoped retrieval (e.g. ['audit-session-17', 'prod-incident']). " +
      "Tags are stored on the Memory node and enable precise filtering via search_memory(tag: '...'). " +
      "Unlike categories (semantic labels auto-assigned by LLM), tags are verbatim identifiers you control."
    ),
};

export function createMcpServer(userId: string, clientName: string): McpServer {
  const server = new McpServer({ name: "mem0-mcp-server", version: "2.0.0" });

  // -------- add_memories --------
  server.registerTool(
    "add_memories",
    {
      description:
        "Write to long-term memory. The system auto-classifies each item:\n" +
        "- Facts/preferences/decisions -> stored (with dedup & supersession)\n" +
        "- 'Forget X' / 'Remove memories about Y' -> matching memories are invalidated\n" +
        "- 'Stop tracking entity Z' -> entity removed from knowledge graph\n" +
        "Pass a single string or array of strings for batch processing.",
      inputSchema: addMemoriesSchema,
    },
    async ({ content, categories: explicitCategories, tags: explicitTags }) => {
      if (!userId) return { content: [{ type: "text", text: "Error: user_id not provided" }] };
      if (!clientName) return { content: [{ type: "text", text: "Error: client_name not provided" }] };

      // Normalise to array -- accepts a single string for backward compatibility
      const items: string[] = Array.isArray(content) ? content : [content];
      if (items.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
      }

      const t0 = Date.now();
      console.log(`[MCP] add_memories start userId=${userId} batch=${items.length}`);

      try {
        /**
         * Process items SEQUENTIALLY to avoid concurrent write-transaction conflicts
         * on both Memgraph and KuzuDB. Parallel sessions from Promise.all can deadlock
         * when they attempt to MERGE the same User/App nodes simultaneously.
         * Sequential processing also ensures dedup TOCTOU safety: each item's
         * near-duplicate check completes before the next item's write begins.
         *
         * Tantivy write-conflict prevention: entity extraction from the PREVIOUS item
         * is awaited (up to PER_ITEM_DRAIN_MAX_MS) before the next write starts.
         * A global BATCH_DRAIN_BUDGET_MS cap prevents the drain from consuming more
         * than ~12 s total across the whole batch (MCP-02).
         * runWrite() also retries on transient Tantivy errors as a defense-in-depth.
         */
        const PER_ITEM_DRAIN_MAX_MS = 3_000;
        const BATCH_DRAIN_BUDGET_MS = 12_000; // global cap across the entire batch
        const batchDrainDeadline = Date.now() + BATCH_DRAIN_BUDGET_MS;

        type MemoryResult =
          | { id: string;   memory: string; event: "ADD" | "SUPERSEDE" | "SKIP_DUPLICATE" }
          | { id: null;     memory: string; event: "ERROR"; error: string }
          | { id: null;     memory: string; event: "INVALIDATE"; invalidated: Array<{ id: string; content: string }> }
          | { id: null;     memory: string; event: "DELETE_ENTITY"; deleted: { entity: string; mentionEdgesRemoved: number; relationshipsRemoved: number } | null };
        const results: MemoryResult[] = [];

        let prevExtractionPromise: Promise<void> | null = null;

        for (const text of items) {
          // Drain previous item's entity extraction before starting the next write,
          // capped per-item and by the remaining global budget (MCP-02).
          if (prevExtractionPromise) {
            const remaining = Math.max(0, batchDrainDeadline - Date.now());
            await Promise.race([
              prevExtractionPromise,
              new Promise<void>((r) => setTimeout(r, Math.min(PER_ITEM_DRAIN_MAX_MS, remaining))),
            ]);
            prevExtractionPromise = null;
          }

          try {
            // Step 0: Intent classification (fast regex -> LLM fallback)
            // Fail-open: if classification throws, default to STORE so the
            // memory is still persisted rather than lost.
            let intent: Awaited<ReturnType<typeof classifyIntent>>;
            try {
              intent = await classifyIntent(text);
            } catch (classifyErr) {
              console.warn(
                `[MCP] classifyIntent error, defaulting to STORE: ${classifyErr instanceof Error ? classifyErr.message : String(classifyErr)}`
              );
              intent = { type: "STORE" };
            }

            if (intent.type === "INVALIDATE") {
              console.log(`[MCP] add_memories INVALIDATE target="${intent.target}"`);
              const invalidated = await invalidateMemoriesByDescription(intent.target, userId);
              results.push({ id: null, memory: text, event: "INVALIDATE", invalidated });
              continue;
            }

            if (intent.type === "DELETE_ENTITY") {
              console.log(`[MCP] add_memories DELETE_ENTITY name="${intent.entityName}"`);
              const deleted = await deleteEntityByNameOrId(userId, undefined, intent.entityName);
              results.push({ id: null, memory: text, event: "DELETE_ENTITY", deleted });
              continue;
            }

            // Step 1: Deduplication pre-write hook (STORE intent)
            const dedup = await checkDeduplication(text, userId);

            if (dedup.action === "skip") {
              console.log(`[MCP] add_memories dedup skip -- duplicate of ${dedup.existingId}`);
              results.push({ id: dedup.existingId, memory: text, event: "SKIP_DUPLICATE" });
              continue;
            }

            let id: string;
            if (dedup.action === "supersede") {
              console.log(`[MCP] add_memories dedup supersede -- superseding ${dedup.existingId}`);
              id = await supersedeMemory(dedup.existingId, text, userId, clientName);
            } else {
              id = await addMemory(text, {
                userId,
                appName: clientName,
                metadata: { source_app: "openmemory", mcp_client: clientName },
                tags: explicitTags,
              });
            }

            const event = dedup.action === "supersede" ? "SUPERSEDE" : "ADD";

            // Write explicit tags to the memory node (for both ADD and SUPERSEDE).
            // supersedeMemory() creates a new node without tags, so we patch them here.
            if (explicitTags && explicitTags.length > 0) {
              await runWrite(
                `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memId})
                 SET m.tags = $tags`,
                { userId, memId: id, tags: explicitTags }
              ).catch((e: unknown) => console.warn("[explicit tags]", e));
            }

            // Write explicit categories (if provided) immediately after the memory is created.
            // The LLM auto-categorizer (inside addMemory/supersedeMemory) still runs
            // fire-and-forget and may add additional categories via MERGE (no duplicates).
            if (explicitCategories && explicitCategories.length > 0) {
              for (const catName of explicitCategories) {
                await runWrite(
                  `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memId})
                   MERGE (c:Category {name: $name})
                   MERGE (m)-[:HAS_CATEGORY]->(c)`,
                  { userId, memId: id, name: catName }
                ).catch((e: unknown) => console.warn("[explicit category]", e));
              }
            }

            // Spec 04: Async entity extraction -- tracked so next iteration can drain it
            prevExtractionPromise = processEntityExtraction(id)
              .catch((e: unknown) => console.warn("[entity worker]", e));

            results.push({ id, memory: text, event });
          } catch (itemErr: unknown) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            console.error(`[MCP] add_memories item error text.slice(0,80)="${text.slice(0, 80)}" err=${msg}`);
            results.push({ id: null, memory: text, event: "ERROR", error: msg });
          }
        }

        // Drain the last item's entity extraction, respecting the remaining global budget (MCP-02)
        if (prevExtractionPromise) {
          const remaining = Math.max(0, batchDrainDeadline - Date.now());
          await Promise.race([
            prevExtractionPromise,
            new Promise<void>((r) => setTimeout(r, remaining)),
          ]);
        }

        console.log(`[MCP] add_memories done in ${Date.now() - t0}ms batch=${items.length}`);

        return {
          content: [{ type: "text", text: JSON.stringify({ results }) }],
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Error in add_memories:", msg);
        return { content: [{ type: "text", text: `Error adding memories: ${msg}` }] };
      }
    }
  );

  // -------- search_memory (dual-mode + entity enrichment) --------
  //
  //   query absent / empty  ->  BROWSE MODE
  //     Chronological listing sorted by createdAt DESC.
  //     Supports offset + limit pagination and returns total count.
  //
  //   query present  ->  SEARCH MODE
  //     Hybrid BM25 + vector search via Reciprocal Rank Fusion.
  //     Auto-enriched with matching entity profiles and relationships.
  //
  server.registerTool(
    "search_memory",
    {
      description:
        "Dual-mode memory + knowledge tool.\n" +
        "SEARCH (query provided): hybrid BM25 + vector search, auto-enriched with matching " +
        "entity profiles and their relationships -- use for specific recall, entity lookup, " +
        "incident investigation, or any targeted question.\n" +
        "BROWSE (query omitted): returns all memories newest-first with total count and " +
        "offset/limit pagination -- use on cold-start to see what is already known.",
      inputSchema: searchMemorySchema,
    },
    async ({ query, limit, offset, category, created_after, include_entities, tag }) => {
      if (!userId) return { content: [{ type: "text", text: "Error: user_id not provided" }] };
      if (!clientName) return { content: [{ type: "text", text: "Error: client_name not provided" }] };

      const browseMode = !query || query.trim() === "";

      try {
        const t0 = Date.now();

        // -- BROWSE MODE --
        if (browseMode) {
          const effectiveLimit = Math.min(limit ?? 50, 200);
          const effectiveOffset = offset ?? 0;
          console.log(`[MCP] search_memory browse userId=${userId} limit=${effectiveLimit} offset=${effectiveOffset} category=${category} tag=${tag}`);

          // Build params without undefined values — Memgraph warns on unused params (MCP-01)
          const browseParams: Record<string, unknown> = { userId, offset: effectiveOffset, limit: effectiveLimit };
          if (category) browseParams.category = category;
          if (tag) browseParams.tag = tag;

          const countRows = await runRead<{ total: number }>(
            `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
             WHERE m.invalidAt IS NULL AND m.state <> 'deleted'
             ${tag ? `AND ANY(t IN coalesce(m.tags, []) WHERE toLower(t) = toLower($tag))` : ""}
             ${category ? `MATCH (m)-[:HAS_CATEGORY]->(cFilter:Category) WHERE toLower(cFilter.name) = toLower($category)` : ""}
             RETURN count(m) AS total`,
            browseParams
          );
          const total = countRows[0]?.total ?? 0;

          const rows = await runRead<{
            id: string; content: string; createdAt: string; updatedAt: string; categories: string[]; tags: string[];
          }>(
            `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
             WHERE m.invalidAt IS NULL AND m.state <> 'deleted'
             ${tag ? `AND ANY(t IN coalesce(m.tags, []) WHERE toLower(t) = toLower($tag))` : ""}
             ${category ? `MATCH (m)-[:HAS_CATEGORY]->(cFilter:Category) WHERE toLower(cFilter.name) = toLower($category)` : ""}
             OPTIONAL MATCH (m)-[:HAS_CATEGORY]->(c:Category)
             WITH m, collect(c.name) AS categories
             ORDER BY m.createdAt DESC
             SKIP $offset
             LIMIT $limit
             RETURN m.id AS id, m.content AS content,
                    m.createdAt AS createdAt, m.updatedAt AS updatedAt,
                    categories, coalesce(m.tags, []) AS tags`,
            browseParams
          );

          console.log(`[MCP] search_memory browse done in ${Date.now() - t0}ms count=${rows.length} total=${total}`);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                total,
                offset: effectiveOffset,
                limit: effectiveLimit,
                results: rows.map((m) => ({
                  id: m.id,
                  memory: m.content,
                  created_at: m.createdAt,
                  updated_at: m.updatedAt,
                  categories: m.categories ?? [],
                  tags: m.tags ?? [],
                })),
              }, null, 2),
            }],
          };
        }

        // -- SEARCH MODE --
        const effectiveLimit = limit ?? 10;
        console.log(`[MCP] search_memory search userId=${userId} query="${query}" limit=${effectiveLimit}`);

        // Spec 02: hybrid search (BM25 + vector + RRF)
        const results = await hybridSearch(query!, {
          userId,
          topK: effectiveLimit,
          mode: "hybrid",
        });

        // Apply optional post-filters (category, date, tag)
        let filtered = results;
        if (category) {
          const catLower = category.toLowerCase();
          filtered = filtered.filter(r => r.categories.some(c => c.toLowerCase() === catLower));
        }
        if (created_after) {
          filtered = filtered.filter(r => r.createdAt >= created_after);
        }
        if (tag) {
          const tagLower = tag.toLowerCase();
          filtered = filtered.filter(r =>
            Array.isArray(r.tags) && r.tags.some((t: string) => t.toLowerCase() === tagLower)
          );
        }

        console.log(`[MCP] search_memory search done in ${Date.now() - t0}ms hits=${results.length} filtered=${filtered.length}`);

        // Log access for each hit -- fire-and-forget
        if (filtered.length > 0) {
          const now = new Date().toISOString();
          const ids = filtered.map(r => r.id);
          runWrite(
            `MERGE (a:App {appName: $appName})
             WITH a
             MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
             WHERE m.id IN $ids
             CREATE (a)-[:ACCESSED {accessedAt: $accessedAt, queryUsed: $query}]->(m)`,
            { appName: clientName, userId, ids, accessedAt: now, query }
          ).catch(() => {/* non-critical */});
        }

        // Entity enrichment -- auto-detect entities matching the query
        // Returns entity profiles with relationships to give agents full knowledge context
        const shouldEnrichEntities = include_entities !== false; // default true
        let entities: EntityProfile[] = [];
        if (shouldEnrichEntities) {
          try {
            entities = await searchEntities(query!, userId, { limit: 5 });
          } catch {
            // Entity enrichment is best-effort -- never block search results
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              // Eval v4 Finding 3: low-confidence flag when no BM25 hit and scores are weak
              ...(filtered.length > 0 ? (() => {
                const hasAnyTextHit = filtered.some(r => r.textRank !== null);
                const maxScore = Math.max(...filtered.map(r => r.rrfScore));
                const confident = hasAnyTextHit || maxScore > 0.02;
                return {
                  confident,
                  message: confident
                    ? "Found relevant results."
                    : "Found some results, but confidence is LOW. These might not be relevant to your query.",
                };
              })() : { confident: true, message: "No results found." }),
              results: filtered.map((r) => {
                const normalizedScore = Math.min(1.0, Math.round((r.rrfScore / 0.032786) * 100) / 100);
                return {
                  id: r.id,
                  memory: r.content,
                  relevance_score: normalizedScore,
                  raw_score: r.rrfScore,
                  text_rank: r.textRank,
                  vector_rank: r.vectorRank,
                  created_at: r.createdAt,
                  categories: r.categories,
                };
              }),
              ...(entities.length > 0 ? {
                entities: entities.map((e) => ({
                  id: e.id,
                  name: e.name,
                  type: e.type,
                  description: e.description,
                  memory_count: e.memoryCount,
                  relationships: e.relationships,
                })),
              } : {}),
            }, null, 2),
          }],
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Error in search_memory:", msg);
        return { content: [{ type: "text", text: `Error searching memory: ${msg}` }] };
      }
    }
  );

  return server;
}
