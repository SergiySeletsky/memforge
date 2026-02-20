/**
 * GET /api/v1/memories/categories — list unique categories for a user's active memories
 *
 * Port of openmemory/api/app/routers/memories.py (GET /categories)
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { categories, memories, memoryCategories, type MemoryState } from "@/lib/db/schema";
import { eq, ne, and, inArray } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/db/helpers";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId) {
    return NextResponse.json({ detail: "user_id is required" }, { status: 400 });
  }

  const db = getDb();
  const user = getOrCreateUser(userId);

  // Get non-deleted, non-archived memory IDs for this user
  const userMemories = db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.userId, user.id),
        ne(memories.state, "deleted" as MemoryState),
        ne(memories.state, "archived" as MemoryState),
      )
    )
    .all();
  const memoryIds = userMemories.map((m) => m.id);

  if (memoryIds.length === 0) {
    return NextResponse.json({ categories: [], total: 0 });
  }

  // Get category IDs linked to those memories
  const mcRows = db
    .select({ categoryId: memoryCategories.categoryId })
    .from(memoryCategories)
    .where(inArray(memoryCategories.memoryId, memoryIds))
    .all();
  const uniqueCatIds = [...new Set(mcRows.map((r) => r.categoryId))];

  if (uniqueCatIds.length === 0) {
    return NextResponse.json({ categories: [], total: 0 });
  }

  const cats = db
    .select()
    .from(categories)
    .where(inArray(categories.id, uniqueCatIds))
    .all();

  return NextResponse.json({
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      created_at: c.createdAt,
    })),
    total: cats.length,
  });
}
