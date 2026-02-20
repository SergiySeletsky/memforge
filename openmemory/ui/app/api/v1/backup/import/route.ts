/**
 * POST /api/v1/backup/import — import memories from exported zip file
 *
 * Port of openmemory/api/app/routers/backup.py (POST /import)
 *
 * Accepts a .zip file containing:
 *   - memories.json  (required) — relational DB export
 *   - memories.jsonl.gz (optional) — provider-agnostic gzip JSONL for re-embedding
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  users,
  apps,
  memories,
  categories,
  memoryCategories,
  memoryStatusHistory,
  type MemoryState,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import JSZip from "jszip";
import { gunzipSync } from "zlib";
import { getMemoryClient } from "@/lib/mem0/client";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const userId = formData.get("user_id") as string;
  const mode = (formData.get("mode") as string) || "overwrite";

  if (!file || !userId) {
    return NextResponse.json({ detail: "file and user_id are required" }, { status: 400 });
  }

  if (mode !== "skip" && mode !== "overwrite") {
    return NextResponse.json({ detail: "Invalid mode. Must be 'skip' or 'overwrite'" }, { status: 400 });
  }

  const db = getDb();
  const user = db.select().from(users).where(eq(users.userId, userId)).get();
  if (!user) {
    return NextResponse.json({ detail: "User not found" }, { status: 404 });
  }

  // Parse zip file
  let sqliteData: any;
  let memoriesBlob: Buffer | null = null;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    // Find memories.json (case-insensitive, may be nested)
    const jsonEntry = Object.keys(zip.files).find((name) =>
      name.toLowerCase().endsWith("memories.json")
    );
    if (!jsonEntry) {
      return NextResponse.json({ detail: "memories.json missing in zip" }, { status: 400 });
    }
    const jsonText = await zip.files[jsonEntry].async("string");
    sqliteData = JSON.parse(jsonText);

    // Look for optional memories.jsonl.gz
    const jsonlEntry = Object.keys(zip.files).find((name) =>
      name.toLowerCase().endsWith("memories.jsonl.gz")
    );
    if (jsonlEntry) {
      memoriesBlob = Buffer.from(await zip.files[jsonlEntry].async("arraybuffer"));
    }
  } catch (err: any) {
    // Fall back to plain JSON for backward compatibility
    try {
      const text = await file.text();
      sqliteData = JSON.parse(text);
    } catch {
      return NextResponse.json({ detail: "Invalid zip or JSON file" }, { status: 400 });
    }
  }

  // Ensure default app exists
  let defaultApp = db
    .select()
    .from(apps)
    .where(and(eq(apps.ownerId, user.id), eq(apps.name, "openmemory")))
    .get();
  if (!defaultApp) {
    defaultApp = db
      .insert(apps)
      .values({ ownerId: user.id, name: "openmemory", isActive: true })
      .returning()
      .get();
  }

  // Import categories
  const catIdMap: Record<string, string> = {};
  for (const c of sqliteData.categories || []) {
    let cat = db.select().from(categories).where(eq(categories.name, c.name)).get();
    if (!cat) {
      cat = db
        .insert(categories)
        .values({ name: c.name, description: c.description || null })
        .returning()
        .get();
    }
    catIdMap[c.id] = cat.id;
  }

  // Import memories
  const oldToNewId: Record<string, string> = {};
  for (const m of sqliteData.memories || []) {
    const incomingId = m.id;
    const existing = db.select().from(memories).where(eq(memories.id, incomingId)).get();

    let targetId: string;
    if (existing && existing.userId !== user.id) {
      targetId = uuidv4();
    } else {
      targetId = incomingId;
    }
    oldToNewId[m.id] = targetId;

    if (existing && existing.userId === user.id && mode === "skip") {
      continue;
    }

    const state = (m.state || "active") as MemoryState;

    if (existing && existing.userId === user.id && mode === "overwrite") {
      db.update(memories)
        .set({
          appId: defaultApp.id,
          content: m.content || "",
          metadata: m.metadata || {},
          state,
          archivedAt: m.archived_at || null,
          deletedAt: m.deleted_at || null,
          updatedAt: m.updated_at || new Date().toISOString(),
        })
        .where(eq(memories.id, incomingId))
        .run();
      continue;
    }

    db.insert(memories)
      .values({
        id: targetId,
        userId: user.id,
        appId: defaultApp.id,
        content: m.content || "",
        metadata: m.metadata || {},
        state,
        createdAt: m.created_at || new Date().toISOString(),
        updatedAt: m.updated_at || new Date().toISOString(),
        archivedAt: m.archived_at || null,
        deletedAt: m.deleted_at || null,
      })
      .run();
  }

  // Import memory-category links
  for (const link of sqliteData.memory_categories || []) {
    const mid = oldToNewId[link.memory_id];
    const cid = catIdMap[link.category_id];
    if (!mid || !cid) continue;

    const exists = db
      .select()
      .from(memoryCategories)
      .where(and(eq(memoryCategories.memoryId, mid), eq(memoryCategories.categoryId, cid)))
      .get();
    if (!exists) {
      db.insert(memoryCategories).values({ memoryId: mid, categoryId: cid }).run();
    }
  }

  // Import status history
  for (const h of sqliteData.status_history || []) {
    const memId = oldToNewId[h.memory_id] || h.memory_id;
    const existing = db.select().from(memoryStatusHistory).where(eq(memoryStatusHistory.id, h.id)).get();
    if (existing && mode === "skip") continue;

    if (existing) {
      db.update(memoryStatusHistory)
        .set({
          memoryId: memId,
          changedBy: user.id,
          oldState: (h.old_state || "active") as MemoryState,
          newState: (h.new_state || "active") as MemoryState,
          changedAt: h.changed_at || new Date().toISOString(),
        })
        .where(eq(memoryStatusHistory.id, h.id))
        .run();
    } else {
      db.insert(memoryStatusHistory)
        .values({
          id: h.id,
          memoryId: memId,
          changedBy: user.id,
          oldState: (h.old_state || "active") as MemoryState,
          newState: (h.new_state || "active") as MemoryState,
          changedAt: h.changed_at || new Date().toISOString(),
        })
        .run();
    }
  }

  // Vector store re-embedding
  try {
    const memoryClient = getMemoryClient();
    const vectorStore = memoryClient?.vector_store;
    const embeddingModel = memoryClient?.embedding_model;

    if (vectorStore && embeddingModel) {
      // Build logical records from JSONL.gz if available, otherwise from memories array
      const logicalRecords: Array<{
        id: string;
        content: string;
        metadata: Record<string, any>;
        created_at?: string;
        updated_at?: string;
      }> = [];

      if (memoriesBlob) {
        try {
          const decompressed = gunzipSync(memoriesBlob);
          const lines = decompressed.toString("utf-8").split("\n").filter(Boolean);
          for (const line of lines) {
            logicalRecords.push(JSON.parse(line));
          }
        } catch (e) {
          console.warn("Failed to decompress memories.jsonl.gz, falling back to memories array", e);
        }
      }

      if (logicalRecords.length === 0) {
        for (const m of sqliteData.memories || []) {
          logicalRecords.push({
            id: m.id,
            content: m.content,
            metadata: m.metadata || {},
            created_at: m.created_at,
            updated_at: m.updated_at,
          });
        }
      }

      for (const rec of logicalRecords) {
        const oldId = rec.id;
        const newId = oldToNewId[oldId] || oldId;
        const content = rec.content || "";

        if (mode === "skip") {
          try {
            const existing = vectorStore.get?.(String(newId));
            if (existing) continue;
          } catch {
            // ignore
          }
        }

        const payload: Record<string, any> = { ...(rec.metadata || {}) };
        payload.data = content;
        if (rec.created_at) payload.created_at = rec.created_at;
        if (rec.updated_at) payload.updated_at = rec.updated_at;
        payload.user_id = userId;
        if (!payload.source_app) payload.source_app = "openmemory";

        try {
          const vec = await embeddingModel.embed(content, "add");
          await vectorStore.insert({ vectors: [vec], payloads: [payload], ids: [String(newId)] });
        } catch (e) {
          console.warn(`Vector upsert failed for memory ${newId}:`, e);
        }
      }
    }
  } catch (e) {
    console.warn("Vector re-embedding skipped (client unavailable):", e);
  }

  return NextResponse.json({ message: `Import completed into user "${userId}"` });
}
