/**
 * MCP Server for OpenMemory — TypeScript port
 *
 * Implements 5 MCP tools:
 *   add_memories, search_memory, list_memories, delete_memories, delete_all_memories
 *
 * Uses @modelcontextprotocol/sdk with SSE transport.
 * Context (user_id, client_name) is passed per-connection via the SSE URL path.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  memories,
  memoryAccessLogs,
  memoryStatusHistory,
  type MemoryState,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getUserAndApp } from "@/lib/db/helpers";
import { getMemoryClient } from "@/lib/mem0/client";
import { checkMemoryAccessPermissions } from "@/lib/permissions";

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

  // Helper: safe memory client
  function getMemoryClientSafe() {
    try {
      return getMemoryClient();
    } catch (e) {
      console.warn("Failed to get memory client:", e);
      return null;
    }
  }

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

      const memoryClient = getMemoryClientSafe();
      if (!memoryClient) {
        return { content: [{ type: "text", text: "Error: Memory system is currently unavailable." }] };
      }

      try {
        const db = getDb();
        const { user, app } = getUserAndApp(userId, clientName);

        if (!app.isActive) {
          return {
            content: [{ type: "text", text: `Error: App ${app.name} is currently paused on OpenMemory.` }],
          };
        }

        const response = await memoryClient.add(text, {
          userId,
          metadata: { source_app: "openmemory", mcp_client: clientName },
        });

        if (response && typeof response === "object" && "results" in response) {
          for (const result of (response as any).results) {
            const memoryId = result.id;
            const existing = db.select().from(memories).where(eq(memories.id, memoryId)).get();

            if (result.event === "ADD") {
              if (!existing) {
                db.insert(memories)
                  .values({
                    id: memoryId,
                    userId: user.id,
                    appId: app.id,
                    content: result.memory,
                    state: "active" as MemoryState,
                  })
                  .run();
              } else {
                db.update(memories)
                  .set({ state: "active" as MemoryState, content: result.memory })
                  .where(eq(memories.id, memoryId))
                  .run();
              }
              db.insert(memoryStatusHistory)
                .values({
                  memoryId,
                  changedBy: user.id,
                  oldState: existing ? (existing.state as MemoryState) : ("deleted" as MemoryState),
                  newState: "active" as MemoryState,
                })
                .run();
            } else if (result.event === "DELETE") {
              if (existing) {
                db.update(memories)
                  .set({ state: "deleted" as MemoryState, deletedAt: new Date().toISOString() })
                  .where(eq(memories.id, memoryId))
                  .run();
                db.insert(memoryStatusHistory)
                  .values({
                    memoryId,
                    changedBy: user.id,
                    oldState: "active" as MemoryState,
                    newState: "deleted" as MemoryState,
                  })
                  .run();
              }
            }
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(response) }] };
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

      const memoryClient = getMemoryClientSafe();
      if (!memoryClient) {
        return { content: [{ type: "text", text: "Error: Memory system is currently unavailable." }] };
      }

      try {
        const db = getDb();
        const { user, app } = getUserAndApp(userId, clientName);

        // Get accessible memories
        const userMems = db
          .select()
          .from(memories)
          .where(eq(memories.userId, user.id))
          .all();
        const accessibleIds = new Set(
          userMems
            .filter((m) =>
              checkMemoryAccessPermissions(m.state as MemoryState, m.id, app.id)
            )
            .map((m) => m.id)
        );

        // Search vector store
        const searchResults = await memoryClient.search(query, { userId });
        const results: any[] = [];

        if (Array.isArray(searchResults)) {
          for (const h of searchResults) {
            if (!h.id || !accessibleIds.has(h.id)) continue;
            results.push({
              id: h.id,
              memory: h.memory || h.payload?.data,
              score: h.score,
              created_at: h.created_at || h.payload?.created_at,
              updated_at: h.updated_at || h.payload?.updated_at,
            });
            // Log access
            db.insert(memoryAccessLogs)
              .values({
                memoryId: h.id,
                appId: app.id,
                accessType: "search",
                metadata: { query, score: h.score },
              })
              .run();
          }
        }

        return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
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

      const memoryClient = getMemoryClientSafe();
      if (!memoryClient) {
        return { content: [{ type: "text", text: "Error: Memory system is currently unavailable." }] };
      }

      try {
        const db = getDb();
        const { user, app } = getUserAndApp(userId, clientName);

        const allMemories = await memoryClient.getAll({ userId });
        const userMems = db.select().from(memories).where(eq(memories.userId, user.id)).all();
        const accessibleIds = new Set(
          userMems
            .filter((m) =>
              checkMemoryAccessPermissions(m.state as MemoryState, m.id, app.id)
            )
            .map((m) => m.id)
        );

        const filtered: any[] = [];
        const memList = Array.isArray(allMemories)
          ? allMemories
          : (allMemories as any)?.results || [];

        for (const mem of memList) {
          if (!mem.id || !accessibleIds.has(mem.id)) continue;
          db.insert(memoryAccessLogs)
            .values({
              memoryId: mem.id,
              appId: app.id,
              accessType: "list",
              metadata: { hash: mem.hash },
            })
            .run();
          filtered.push(mem);
        }

        return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
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

      const memoryClient = getMemoryClientSafe();
      if (!memoryClient) {
        return { content: [{ type: "text", text: "Error: Memory system is currently unavailable." }] };
      }

      try {
        const db = getDb();
        const { user, app } = getUserAndApp(userId, clientName);

        const userMems = db.select().from(memories).where(eq(memories.userId, user.id)).all();
        const accessibleIds = new Set(
          userMems
            .filter((m) =>
              checkMemoryAccessPermissions(m.state as MemoryState, m.id, app.id)
            )
            .map((m) => m.id)
        );

        const idsToDelete = memory_ids.filter((id) => accessibleIds.has(id));
        if (idsToDelete.length === 0) {
          return { content: [{ type: "text", text: "Error: No accessible memories found with provided IDs" }] };
        }

        const now = new Date().toISOString();
        for (const memoryId of idsToDelete) {
          try {
            await memoryClient.delete(memoryId);
          } catch (e) {
            console.warn(`Failed to delete ${memoryId} from vector store:`, e);
          }

          const mem = db.select().from(memories).where(eq(memories.id, memoryId)).get();
          if (mem) {
            db.update(memories)
              .set({ state: "deleted" as MemoryState, deletedAt: now })
              .where(eq(memories.id, memoryId))
              .run();
            db.insert(memoryStatusHistory)
              .values({
                memoryId,
                changedBy: user.id,
                oldState: (mem.state || "active") as MemoryState,
                newState: "deleted" as MemoryState,
              })
              .run();
            db.insert(memoryAccessLogs)
              .values({
                memoryId,
                appId: app.id,
                accessType: "delete",
                metadata: { operation: "delete_by_id" },
              })
              .run();
          }
        }

        return { content: [{ type: "text", text: `Successfully deleted ${idsToDelete.length} memories` }] };
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

      const memoryClient = getMemoryClientSafe();
      if (!memoryClient) {
        return { content: [{ type: "text", text: "Error: Memory system is currently unavailable." }] };
      }

      try {
        const db = getDb();
        const { user, app } = getUserAndApp(userId, clientName);

        const userMems = db.select().from(memories).where(eq(memories.userId, user.id)).all();
        const accessibleIds = userMems
          .filter((m) =>
            checkMemoryAccessPermissions(m.state as MemoryState, m.id, app.id)
          )
          .map((m) => m.id);

        const now = new Date().toISOString();
        for (const memoryId of accessibleIds) {
          try {
            await memoryClient.delete(memoryId);
          } catch (e) {
            console.warn(`Failed to delete ${memoryId} from vector store:`, e);
          }

          db.update(memories)
            .set({ state: "deleted" as MemoryState, deletedAt: now })
            .where(eq(memories.id, memoryId))
            .run();
          db.insert(memoryStatusHistory)
            .values({
              memoryId,
              changedBy: user.id,
              oldState: "active" as MemoryState,
              newState: "deleted" as MemoryState,
            })
            .run();
          db.insert(memoryAccessLogs)
            .values({
              memoryId,
              appId: app.id,
              accessType: "delete_all",
              metadata: { operation: "bulk_delete" },
            })
            .run();
        }

        return { content: [{ type: "text", text: "Successfully deleted all memories" }] };
      } catch (e: any) {
        console.error("Error deleting memories:", e);
        return { content: [{ type: "text", text: `Error deleting memories: ${e.message}` }] };
      }
    }
  );

  return server;
}
