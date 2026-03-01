/**
 * MCP Server for MemForge -- 2-tool architecture
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
import { searchEntities, invalidateMemoriesByDescription, deleteEntityByNameOrId, touchMemoryByDescription, resolveMemoryByDescription } from "@/lib/mcp/entities";
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
  include_entities: z.boolean().optional().describe("Include matching entity profiles in search results (default: true for search mode). Set to false for faster keyword-only recall when entity context is not needed."),
  tag: z.string().optional().describe("Exact tag filter -- returns only memories tagged with this string (case-insensitive). Tags are set via add_memories(tags: [...])."),
};
const addMemoriesSchema = {
  content: z
    .union([z.string(), z.array(z.string())])
    .describe(
      "What to remember. Single string or array of strings.\n" +
      "The system understands natural language intent:\n" +
      "• Statements, facts, decisions → remembered (duplicates auto-detected and merged)\n" +
      "• 'Forget X' / 'Remove memories about Y' → matching memories removed\n" +
      "• 'Stop tracking [entity]' → entity and its connections cleaned up"
    ),
  categories: z
    .array(z.string())
    .optional()
    .describe(
      "Semantic labels for organization (e.g. ['Architecture', 'Security']). " +
      "Applied immediately; the system may also suggest additional categories. " +
      "When omitted, categories are assigned automatically. Any string accepted."
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Exact identifiers for precise filtering (e.g. ['project-x', 'session-5', 'prod-incident']). " +
      "Unlike categories, tags are never auto-assigned — fully caller-controlled. " +
      "Use for project scoping, session tracking, or domain isolation. " +
      "Retrieve later via search_memory(tag: '...')."
    ),
  suppress_auto_categories: z
    .boolean()
    .optional()
    .describe(
      "Skip automatic category suggestions. Auto-defaults to true when you provide explicit categories " +
      "for predictable grouping. Set explicitly to false to keep auto-enrichment alongside your categories."
    ),
};

export function createMcpServer(userId: string, clientName: string): McpServer {
  const server = new McpServer({ name: "memforge-mcp-server", version: "2.0.0" });

  // -------- add_memories --------
  server.registerTool(
    "add_memories",
    {
      description:
        "Store information in long-term memory. Use this PROACTIVELY — save any facts, " +
        "decisions, preferences, patterns, or insights worth remembering across conversations.\n\n" +
        "What to store: user preferences, architecture decisions, project conventions, " +
        "problem solutions, relationships between concepts, workflow patterns, debug findings.\n\n" +
        "The system understands natural language intent:\n" +
        "• Statements → remembered (duplicates automatically detected and merged)\n" +
        "• 'Forget X' / 'Remove memories about Y' → matching memories removed\n" +
        "• 'Stop tracking [entity]' → entity and its connections cleaned up\n" +
        "• 'Still relevant: X' / 'Confirm X still applies' → timestamp refreshed (TOUCH)\n" +
        "• 'Resolved: X' / 'X has been fixed' → memory archived as resolved\n\n" +
        "Accepts a single string or an array for batch writes.",
      inputSchema: addMemoriesSchema,
    },
    async ({ content, categories: explicitCategories, tags: explicitTags, suppress_auto_categories: suppressAutoCategories }) => {
      if (!userId) return { content: [{ type: "text", text: "Error: user_id not provided" }] };
      if (!clientName) return { content: [{ type: "text", text: "Error: client_name not provided" }] };

      // Normalise to array -- accepts a single string for backward compatibility
      const items: string[] = Array.isArray(content) ? content : [content];
      if (items.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({}) }] };
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
          | { id: null;     memory: string; event: "DELETE_ENTITY"; deleted: { entity: string; mentionEdgesRemoved: number; relationshipsRemoved: number } | null }
          | { id: string | null; memory: string; event: "TOUCH"; touched: { id: string; content: string } | null }
          | { id: string | null; memory: string; event: "RESOLVE"; resolved: { id: string; content: string } | null };
        const results: MemoryResult[] = [];

        let prevExtractionPromise: Promise<void> | null = null;

        // MCP-BATCH-DEDUP: Track normalized text of items already processed in this
        // batch to catch exact duplicates before hitting the DB dedup pipeline.
        // The DB pipeline handles semantic near-duplicates, but the vector/text index
        // may have propagation delays within the same batch — this catches identical content.
        const batchSeenTexts = new Set<string>();
        const normalizeBatchText = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

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

            if (intent.type === "TOUCH") {
              console.log(`[MCP] add_memories TOUCH target="${intent.target}"`);
              const touched = await touchMemoryByDescription(intent.target, userId);
              results.push({ id: touched?.id ?? null, memory: text, event: "TOUCH", touched });
              continue;
            }

            if (intent.type === "RESOLVE") {
              console.log(`[MCP] add_memories RESOLVE target="${intent.target}"`);
              const resolved = await resolveMemoryByDescription(intent.target, userId);
              results.push({ id: resolved?.id ?? null, memory: text, event: "RESOLVE", resolved });
              continue;
            }

            // Step 1: Deduplication pre-write hook (STORE intent)
            // MCP-BATCH-DEDUP: Check for intra-batch exact duplicate first
            const normalizedText = normalizeBatchText(text);
            if (batchSeenTexts.has(normalizedText)) {
              console.log(`[MCP] add_memories intra-batch skip -- exact duplicate within batch`);
              results.push({ id: null as unknown as string, memory: text, event: "SKIP_DUPLICATE" });
              continue;
            }

            const dedup = await checkDeduplication(text, userId);

            if (dedup.action === "skip") {
              console.log(`[MCP] add_memories dedup skip -- duplicate of ${dedup.existingId}`);
              results.push({ id: dedup.existingId, memory: text, event: "SKIP_DUPLICATE" });
              continue;
            }

            let id: string;
            if (dedup.action === "supersede") {
              console.log(`[MCP] add_memories dedup supersede -- superseding ${dedup.existingId}`);
              id = await supersedeMemory(dedup.existingId, text, userId, clientName, explicitTags);
            } else {
              id = await addMemory(text, {
                userId,
                appName: clientName,
                metadata: { source_app: "memforge", mcp_client: clientName },
                tags: explicitTags,
                // MCP-CAT-SUPPRESS-AUTO: When caller provides explicit categories
                // and doesn't explicitly set suppress_auto_categories, auto-default
                // to true for predictable grouping without LLM-added noise.
                suppressAutoCategories: suppressAutoCategories ?? (explicitCategories != null && explicitCategories.length > 0),
              });
            }

            const event = dedup.action === "supersede" ? "SUPERSEDE" : "ADD";

            // Write explicit categories (if provided) in a single UNWIND round-trip (MCP-CAT-01 fix).
            // The LLM auto-categorizer (inside addMemory/supersedeMemory) still runs
            // fire-and-forget and may add additional categories via MERGE (no duplicates).
            if (explicitCategories && explicitCategories.length > 0) {
              await runWrite(
                `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memId})
                 WITH m
                 UNWIND $categories AS catName
                 MERGE (c:Category {name: catName})
                 MERGE (m)-[:HAS_CATEGORY]->(c)`,
                { userId, memId: id, categories: explicitCategories }
              ).catch((e: unknown) => console.warn("[explicit categories]", e));
            }

            // Spec 04: Async entity extraction -- tracked so next iteration can drain it
            prevExtractionPromise = processEntityExtraction(id)
              .catch((e: unknown) => console.warn("[entity worker]", e));

            // MCP-BATCH-DEDUP: mark this text as seen for intra-batch dedup
            batchSeenTexts.add(normalizedText);

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

        // â”€â”€ Minimal response â”€â”€
        // Only non-zero counts + ids for stored items + index-correlated errors.
        // Caller already has the input text â€” no echo, no per-item objects.
        const response: Record<string, unknown> = {};

        const addIds = results.filter(r => r.event === "ADD").map(r => r.id);
        const supersedeIds = results.filter(r => r.event === "SUPERSEDE").map(r => r.id);
        const ids = [...addIds, ...supersedeIds].filter(Boolean);
        if (ids.length) response.ids = ids;

        if (addIds.length) response.stored = addIds.length;
        if (supersedeIds.length) response.superseded = supersedeIds.length;

        const skippedCount = results.filter(r => r.event === "SKIP_DUPLICATE").length;
        if (skippedCount) response.skipped = skippedCount;

        // Errors carry index so caller can correlate which input failed
        const errors = results
          .map((r, i) => r.event === "ERROR" ? { index: i, message: (r as any).error } : null)
          .filter(Boolean);
        if (errors.length) response.errors = errors;

        // Invalidate: just a count of invalidated memories
        const invalidatedCount = results
          .filter(r => r.event === "INVALIDATE")
          .reduce((sum, r) => sum + ((r as any).invalidated?.length ?? 0), 0);
        if (invalidatedCount) response.invalidated = invalidatedCount;

        // Delete entity: name of the deleted entity
        const deletedEntity = results.find(r => r.event === "DELETE_ENTITY");
        if (deletedEntity) response.deleted = (deletedEntity as any).deleted?.entity ?? null;

        // Touch: count of memories whose timestamp was refreshed
        const touchedCount = results
          .filter(r => r.event === "TOUCH" && (r as any).touched !== null).length;
        if (touchedCount) response.touched = touchedCount;

        // Resolve: count of memories marked as resolved
        const resolvedCount = results
          .filter(r => r.event === "RESOLVE" && (r as any).resolved !== null).length;
        if (resolvedCount) response.resolved = resolvedCount;

        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
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
        "Recall from long-term memory. Use BEFORE making decisions, writing code, or answering " +
        "questions — always check what's already known first.\n\n" +
        "Two modes:\n" +
        "• With query: finds the most relevant memories and surfaces related entities with " +
        "their connections. Use natural language — be specific and include context.\n" +
        "• Without query: lists all memories newest-first (use to see what's stored, " +
        "or on first interaction).\n\n" +
        "Tip: search 2–3 times with different phrasings to maximize recall. " +
        "Use tags for project/session scoping.",
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

          // Build params without undefined values â€” Memgraph warns on unused params (MCP-01)
          const browseParams: Record<string, unknown> = { userId, offset: effectiveOffset, limit: effectiveLimit };
          if (category) browseParams.category = category;
          if (tag) browseParams.tag = tag;

          // MCP-BROWSE-01 fix: single Cypher query computes count + paginated rows in one round-trip
          const rows = await runRead<{
            id: string; content: string; createdAt: string; updatedAt: string; categories: string[]; tags: string[]; total: number;
          }>(
            `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
             WHERE m.invalidAt IS NULL AND m.state <> 'deleted'
             ${tag ? `AND ANY(t IN coalesce(m.tags, []) WHERE toLower(t) = toLower($tag))` : ""}
             ${category ? `MATCH (m)-[:HAS_CATEGORY]->(cFilter:Category) WHERE toLower(cFilter.name) = toLower($category)` : ""}
             WITH m ORDER BY m.createdAt DESC
             WITH collect(m) AS allMems, count(m) AS total
             UNWIND allMems[toInteger($offset)..(toInteger($offset) + toInteger($limit))] AS m
             OPTIONAL MATCH (m)-[:HAS_CATEGORY]->(c:Category)
             WITH m, collect(c.name) AS categories, total
             RETURN m.id AS id, m.content AS content,
                    m.createdAt AS createdAt, m.updatedAt AS updatedAt,
                    categories, coalesce(m.tags, []) AS tags, total`,
            browseParams
          );
          const total = rows[0]?.total ?? 0;

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
        // MCP-FILTER-02 fix: tag post-filter has lowest selectivity (few memories
        // carry a given tag), so use a higher multiplier to compensate.
        // category/date filters are less aggressive â€” 5Ã— suffices.
        // MCP-TAG-RECALL-02: Guarantee minimum topK of 200 when tag filter is active
        // to match browse-mode recall for typical stores (<200 tagged memories).
        const fetchMultiplier = tag ? 10 : (category || created_after) ? 5 : 1;
        const fetchLimit = tag
          ? Math.max(effectiveLimit * fetchMultiplier, 200)
          : effectiveLimit * fetchMultiplier;
        console.log(`[MCP] search_memory search userId=${userId} query="${query}" limit=${effectiveLimit} fetchLimit=${fetchLimit}`);

        // Spec 02: hybrid search (BM25 + vector + RRF)
        const results = await hybridSearch(query!, {
          userId,
          topK: fetchLimit,
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

        // Cap to requested limit after post-filtering (MCP-FILTER-01)
        const totalMatching = filtered.length;
        filtered = filtered.slice(0, effectiveLimit);

        console.log(`[MCP] search_memory search done in ${Date.now() - t0}ms hits=${results.length} filtered=${filtered.length}`);

        // MCP-TAG-RECALL-01: warn when tag post-filter drops >70% of results,
        // indicating the fetchMultiplier may be insufficient or browse mode is better.
        let tagFilterWarning: string | undefined;
        if (tag && results.length > 0 && totalMatching < results.length * 0.3) {
          tagFilterWarning =
            `Tag filter '${tag}' matched only ${totalMatching} of ${results.length} search results. ` +
            `For complete recall, use browse mode (no query) with tag filter, which scans all tagged memories.`;
        }

        // Log access for each hit -- fire-and-forget (ACCESS-LOG-01: MERGE to prevent unbounded edge growth)
        if (filtered.length > 0) {
          const now = new Date().toISOString();
          const ids = filtered.map(r => r.id);
          runWrite(
            `MERGE (a:App {appName: $appName})
             WITH a
             MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
             WHERE m.id IN $ids
             MERGE (a)-[rel:ACCESSED]->(m)
             SET rel.accessedAt = $accessedAt, rel.queryUsed = $query, rel.accessCount = coalesce(rel.accessCount, 0) + 1`,
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
              // Total pre-filter matches before limit cap — lets agents know when
              // more results exist beyond the requested limit (MCP-TOTAL-01).
              total_matching: totalMatching,
              // Confidence heuristic (MCP-CONFIDENCE-02):
              // RRF single-arm floor â‰ˆ 1/(K+1) where K=60 â†’ 0.0164. Scores above
              // 0.012 indicate at least one arm ranked the result in the top half.
              // Previous 0.02 threshold caused false-negatives for valid vector-only results.
              ...(filtered.length > 0 ? (() => {
                const hasAnyTextHit = filtered.some(r => r.textRank !== null);
                const maxScore = Math.max(...filtered.map(r => r.rrfScore));
                const confident = hasAnyTextHit || maxScore > 0.012;
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
                  updated_at: r.updatedAt ?? r.createdAt,
                  categories: r.categories,
                  tags: r.tags ?? [],
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
              ...(tagFilterWarning ? { tag_filter_warning: tagFilterWarning } : {}),
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
