/**
 * MCP Server for OpenMemory — Spec 00 Memgraph port
 *
 * Implements 5 MCP tools:
 *   add_memories, search_memory, list_memories, delete_memories, delete_all_memories
 *
 * Uses @modelcontextprotocol/sdk with SSE transport.
 * Context (user_id, client_name) is passed per-connection via the SSE URL path.
 *
 * Storage: Memgraph via lib/memory/write.ts + lib/memory/search.ts
 * (replaces SQLite/Drizzle + mem0ai SDK dual-backend approach)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addMemory, deleteMemory, deleteAllMemories, supersedeMemory } from "@/lib/memory/write";
import { searchMemories, listMemories } from "@/lib/memory/search";
import { hybridSearch } from "@/lib/search/hybrid";
import { runWrite } from "@/lib/db/memgraph";
import { checkDeduplication } from "@/lib/dedup";
import { processEntityExtraction } from "@/lib/entities/worker";

/**
 * Create a new McpServer instance with all 5 tools registered.
 * Each request carries userId & clientName via closure.
 */
// Pre-define tool input schemas to avoid TS2589 deep type instantiation
const addMemoriesSchema = { text: z.string() };
const searchMemorySchema = { query: z.string() };
const deleteMemoriesSchema = { memory_ids: z.array(z.string()) };

export function createMcpServer(userId: string, clientName: string): McpServer {
  const server = new McpServer({ name: "mem0-mcp-server", version: "1.0.0" });

  // -------- add_memories --------
  server.registerTool(
    "add_memories",
    {
      description: "Add a new memory. Called when the user shares personal info, preferences, or asks to remember something.",
      inputSchema: addMemoriesSchema,
    },
    async ({ text }) => {
      if (!userId) return { content: [{ type: "text", text: "Error: user_id not provided" }] };
      if (!clientName) return { content: [{ type: "text", text: "Error: client_name not provided" }] };

      try {
        const t0 = Date.now();
        console.log(`[MCP] add_memories start for userId=${userId} text.length=${text.length}`);

        // Spec 03: Deduplication pre-write hook
        const dedup = await checkDeduplication(text, userId);

        if (dedup.action === "skip") {
          console.log(`[MCP] add_memories dedup skip — duplicate of ${dedup.existingId}`);
          return {
            content: [{ type: "text", text: JSON.stringify({ results: [{ id: dedup.existingId, memory: text, event: "SKIP_DUPLICATE" }] }) }],
          };
        }

        let id: string;
        if (dedup.action === "supersede") {
          console.log(`[MCP] add_memories dedup supersede — superseding ${dedup.existingId}`);
          id = await supersedeMemory(dedup.existingId, text, userId, clientName);
        } else {
          id = await addMemory(text, {
            userId,
            appName: clientName,
            metadata: { source_app: "openmemory", mcp_client: clientName },
          });
        }

        const event = dedup.action === "supersede" ? "SUPERSEDE" : "ADD";
        console.log(`[MCP] add_memories done in ${Date.now() - t0}ms id=${id} event=${event}`);

        // Spec 04: Async entity extraction — fire-and-forget, never blocks MCP response
        processEntityExtraction(id).catch((e) => console.warn("[entity worker]", e));

        return {
          content: [{ type: "text", text: JSON.stringify({ results: [{ id, memory: text, event }] }) }],
        };
      } catch (e: any) {
        console.error("Error adding memory:", e);
        return { content: [{ type: "text", text: `Error adding to memory: ${e.message}` }] };
      }
    }
  );

  // -------- search_memory --------
  server.registerTool(
    "search_memory",
    {
      description: "Search through stored memories. Called EVERY TIME the user asks anything.",
      inputSchema: searchMemorySchema,
    },
    async ({ query }) => {
      if (!userId) return { content: [{ type: "text", text: "Error: user_id not provided" }] };
      if (!clientName) return { content: [{ type: "text", text: "Error: client_name not provided" }] };

      try {
        const t0 = Date.now();
        console.log(`[MCP] search_memory start for userId=${userId} query="${query}"`);

        // Spec 02: use hybrid search (text + vector + RRF) instead of vector-only
        const results = await hybridSearch(query, {
          userId,
          topK: 10,
          mode: "hybrid",
        });

        console.log(`[MCP] search_memory done in ${Date.now() - t0}ms hits=${results.length}`);

        // Log access for each hit — batch write to avoid concurrent MERGE races
        if (results.length > 0) {
          const now = new Date().toISOString();
          const ids = results.map(r => r.id);
          runWrite(
            `MERGE (a:App {appName: $appName})
             WITH a
             MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
             WHERE m.id IN $ids
             CREATE (a)-[:ACCESSED {accessedAt: $accessedAt, queryUsed: $query}]->(m)`,
            { appName: clientName, userId, ids, accessedAt: now, query }
          ).catch(() => {/* non-critical */});
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              results: results.map((r) => ({
                id: r.id,
                memory: r.content,
                score: r.rrfScore,
                text_rank: r.textRank,
                vector_rank: r.vectorRank,
                created_at: r.createdAt,
              })),
            }, null, 2),
          }],
        };
      } catch (e: any) {
        console.error("Error searching memory:", e);
        return { content: [{ type: "text", text: `Error searching memory: ${e.message}` }] };
      }
    }
  );

  // -------- list_memories --------
  server.registerTool(
    "list_memories",
    {
      description: "List all memories in the user's memory",
    },
    async () => {
      if (!userId) return { content: [{ type: "text", text: "Error: user_id not provided" }] };
      if (!clientName) return { content: [{ type: "text", text: "Error: client_name not provided" }] };

      try {
        const t0 = Date.now();
        console.log(`[MCP] list_memories start for userId=${userId}`);

        const { memories: mems } = await listMemories({
          userId,
          appName: clientName,
          pageSize: 200,
        });

        console.log(`[MCP] list_memories done in ${Date.now() - t0}ms count=${mems.length}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              mems.map((m) => ({
                id: m.id,
                memory: m.content,
                created_at: m.createdAt,
                updated_at: m.updatedAt,
              })),
              null, 2
            ),
          }],
        };
      } catch (e: any) {
        console.error("Error listing memories:", e);
        return { content: [{ type: "text", text: `Error getting memories: ${e.message}` }] };
      }
    }
  );

  // -------- delete_memories --------
  server.registerTool(
    "delete_memories",
    {
      description: "Delete specific memories by their IDs",
      inputSchema: deleteMemoriesSchema,
    },
    async ({ memory_ids }) => {
      if (!userId) return { content: [{ type: "text", text: "Error: user_id not provided" }] };
      if (!clientName) return { content: [{ type: "text", text: "Error: client_name not provided" }] };

      try {
        let deleted = 0;
        for (const id of memory_ids) {
          const ok = await deleteMemory(id, userId);
          if (ok) deleted++;
        }

        if (deleted === 0) {
          return { content: [{ type: "text", text: "Error: No accessible memories found with provided IDs" }] };
        }
        return { content: [{ type: "text", text: `Successfully deleted ${deleted} memories` }] };
      } catch (e: any) {
        console.error("Error deleting memories:", e);
        return { content: [{ type: "text", text: `Error deleting memories: ${e.message}` }] };
      }
    }
  );

  // -------- delete_all_memories --------
  server.registerTool(
    "delete_all_memories",
    {
      description: "Delete all memories in the user's memory",
    },
    async () => {
      if (!userId) return { content: [{ type: "text", text: "Error: user_id not provided" }] };
      if (!clientName) return { content: [{ type: "text", text: "Error: client_name not provided" }] };

      try {
        const count = await deleteAllMemories(userId, clientName);
        return { content: [{ type: "text", text: `Successfully deleted ${count} memories` }] };
      } catch (e: any) {
        console.error("Error deleting memories:", e);
        return { content: [{ type: "text", text: `Error deleting memories: ${e.message}` }] };
      }
    }
  );

  return server;
}
