/**
 * GET /api/v1/memories/:memoryId — get single memory
 * PUT /api/v1/memories/:memoryId — update memory text
 *
 * Port of openmemory/api/app/routers/memories.py (GET /{memory_id}, PUT /{memory_id})
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { memories, apps, categories, memoryCategories, memoryStatusHistory, type MemoryState } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/db/helpers";
import { getMemoryOr404, updateMemoryState } from "@/lib/api/helpers";
import { getMemoryClient } from "@/lib/mem0/client";
import { categorizeMemory } from "@/lib/mem0/categorize";

type RouteParams = { params: Promise<{ memoryId: string }> };

// ---------- GET /api/v1/memories/:memoryId ----------
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { memoryId } = await params;
  const db = getDb();

  const mem = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  if (!mem) {
    return NextResponse.json({ detail: "Memory not found" }, { status: 404 });
  }

  const app = db.select().from(apps).where(eq(apps.id, mem.appId)).get();
  const cats = db
    .select({ name: categories.name })
    .from(memoryCategories)
    .innerJoin(categories, eq(memoryCategories.categoryId, categories.id))
    .where(eq(memoryCategories.memoryId, mem.id))
    .all();

  return NextResponse.json({
    id: mem.id,
    text: mem.content,
    created_at: mem.createdAt ? Math.floor(new Date(mem.createdAt).getTime() / 1000) : 0,
    state: mem.state || "active",
    app_id: mem.appId,
    app_name: app?.name || null,
    categories: cats.map((c) => c.name),
    metadata_: mem.metadata as Record<string, unknown> | null,
  });
}

// ---------- PUT /api/v1/memories/:memoryId ----------
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { memoryId } = await params;
  const db = getDb();

  const body = await request.json();
  // Accept both "memory_content" (original Python API / UI hook) and "text" (TS API)
  const text = body.memory_content || body.text;
  const user_id = body.user_id;
  if (!text || !user_id) {
    return NextResponse.json({ detail: "text and user_id are required" }, { status: 400 });
  }

  const user = getOrCreateUser(user_id);
  const mem = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  if (!mem) {
    return NextResponse.json({ detail: "Memory not found" }, { status: 404 });
  }

  // Update in vector store
  let memoryClient: any;
  try {
    memoryClient = getMemoryClient();
    if (!memoryClient) throw new Error("Memory client is not available");
  } catch (e: any) {
    return NextResponse.json(
      { detail: `Memory service unavailable: ${e.message}` },
      { status: 503 }
    );
  }

  try {
    await memoryClient.update(memoryId, text);
  } catch (e: any) {
    console.error("Error updating memory in vector store:", e);
    return NextResponse.json(
      { detail: `Failed to update memory in vector store: ${e.message}` },
      { status: 500 }
    );
  }

  // Update local DB
  db.update(memories)
    .set({ content: text, updatedAt: new Date().toISOString() })
    .where(eq(memories.id, memoryId))
    .run();

  // History entry
  db.insert(memoryStatusHistory)
    .values({
      memoryId,
      changedBy: user.id,
      oldState: (mem.state || "active") as MemoryState,
      newState: (mem.state || "active") as MemoryState,
    })
    .run();

  // Re-categorize
  categorizeMemory(memoryId, text).catch(() => {});

  // Return updated
  const updated = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  const app = db.select().from(apps).where(eq(apps.id, updated!.appId)).get();
  const cats = db
    .select({ name: categories.name })
    .from(memoryCategories)
    .innerJoin(categories, eq(memoryCategories.categoryId, categories.id))
    .where(eq(memoryCategories.memoryId, memoryId))
    .all();

  return NextResponse.json({
    id: updated!.id,
    content: updated!.content,
    created_at: updated!.createdAt ? Math.floor(new Date(updated!.createdAt).getTime() / 1000) : 0,
    state: updated!.state || "active",
    app_id: updated!.appId,
    app_name: app?.name || null,
    categories: cats.map((c) => c.name),
    metadata_: updated!.metadata as Record<string, unknown> | null,
  });
}
