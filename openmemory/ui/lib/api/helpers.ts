/**
 * Common helpers shared across API routes.
 */
import { getDb } from "@/lib/db";
import { memories, memoryStatusHistory } from "@/lib/db/schema";
import type { MemoryState } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Get a memory by ID or return 404 NextResponse.
 */
export function getMemoryOr404(memoryId: string) {
  const db = getDb();
  const memory = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  if (!memory) return null;
  return memory;
}

/**
 * Update memory state and record history.
 */
export function updateMemoryState(
  memoryId: string,
  newState: MemoryState,
  changedByUserId: string
) {
  const db = getDb();
  const memory = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  if (!memory) return null;

  const oldState = memory.state;
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = { state: newState, updatedAt: now };
  if (newState === "archived") updates.archivedAt = now;
  if (newState === "deleted") updates.deletedAt = now;

  db.update(memories).set(updates).where(eq(memories.id, memoryId)).run();

  db.insert(memoryStatusHistory)
    .values({
      memoryId,
      changedBy: changedByUserId,
      oldState: oldState as MemoryState,
      newState,
    })
    .run();

  return db.select().from(memories).where(eq(memories.id, memoryId)).get();
}

/**
 * Parse JSON body safely. Returns parsed body or NextResponse with error.
 */
export async function parseBody<T>(
  request: Request,
  schema: { parse: (data: unknown) => T }
): Promise<T | NextResponse> {
  try {
    const body = await request.json();
    return schema.parse(body);
  } catch (e: any) {
    return NextResponse.json(
      { detail: e.errors || e.message || "Invalid request body" },
      { status: 400 }
    );
  }
}
