/**
 * POST /api/v1/memories/actions/pause — pause/unpause memories
 *
 * Port of openmemory/api/app/routers/memories.py (POST /actions/pause)
 * Supports: global_pause, app_id, all_for_app, memory_ids, category_ids
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { memories, memoryCategories, type MemoryState } from "@/lib/db/schema";
import { eq, and, ne, inArray } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/db/helpers";
import { updateMemoryState } from "@/lib/api/helpers";
import { PauseMemoriesRequestSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = PauseMemoriesRequestSchema.parse(await request.json());
  } catch (e: any) {
    return NextResponse.json({ detail: e.errors || e.message }, { status: 400 });
  }

  const db = getDb();
  const user = getOrCreateUser(body.user_id);
  const state: MemoryState = body.state || "paused";

  if (body.global_pause) {
    const all = db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          ne(memories.state, "deleted" as MemoryState),
          ne(memories.state, "archived" as MemoryState)
        )
      )
      .all();
    for (const m of all) {
      updateMemoryState(m.id, state, user.id);
    }
    return NextResponse.json({ message: "Successfully paused all memories" });
  }

  if (body.app_id) {
    const appMems = db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.appId, body.app_id),
          eq(memories.userId, user.id),
          ne(memories.state, "deleted" as MemoryState),
          ne(memories.state, "archived" as MemoryState)
        )
      )
      .all();
    for (const m of appMems) {
      updateMemoryState(m.id, state, user.id);
    }
    return NextResponse.json({
      message: `Successfully paused all memories for app ${body.app_id}`,
    });
  }

  if (body.all_for_app && body.memory_ids && body.memory_ids.length > 0) {
    const mems = db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.userId, user.id),
          ne(memories.state, "deleted" as MemoryState),
          inArray(memories.id, body.memory_ids)
        )
      )
      .all();
    for (const m of mems) {
      updateMemoryState(m.id, state, user.id);
    }
    return NextResponse.json({ message: "Successfully paused all memories" });
  }

  if (body.memory_ids && body.memory_ids.length > 0) {
    for (const memoryId of body.memory_ids) {
      updateMemoryState(memoryId, state, user.id);
    }
    return NextResponse.json({
      message: `Successfully paused ${body.memory_ids.length} memories`,
    });
  }

  if (body.category_ids && body.category_ids.length > 0) {
    const mc = db
      .select({ memoryId: memoryCategories.memoryId })
      .from(memoryCategories)
      .where(inArray(memoryCategories.categoryId, body.category_ids))
      .all();
    const memoryIds = [...new Set(mc.map((r) => r.memoryId))];
    if (memoryIds.length > 0) {
      const mems = db
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            inArray(memories.id, memoryIds),
            ne(memories.state, "deleted" as MemoryState),
            ne(memories.state, "archived" as MemoryState)
          )
        )
        .all();
      for (const m of mems) {
        updateMemoryState(m.id, state, user.id);
      }
    }
    return NextResponse.json({
      message: `Successfully paused memories in ${body.category_ids.length} categories`,
    });
  }

  return NextResponse.json(
    { detail: "Invalid pause request parameters" },
    { status: 400 }
  );
}
