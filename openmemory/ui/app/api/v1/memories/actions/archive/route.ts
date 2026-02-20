/**
 * POST /api/v1/memories/actions/archive — archive memories by IDs
 *
 * Port of openmemory/api/app/routers/memories.py (POST /actions/archive)
 */
import { NextRequest, NextResponse } from "next/server";
import { updateMemoryState } from "@/lib/api/helpers";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { memory_ids, user_id } = body;

  if (!memory_ids || !Array.isArray(memory_ids) || !user_id) {
    return NextResponse.json(
      { detail: "memory_ids (array) and user_id are required" },
      { status: 400 }
    );
  }

  for (const memoryId of memory_ids) {
    updateMemoryState(memoryId, "archived", user_id);
  }

  return NextResponse.json({
    message: `Successfully archived ${memory_ids.length} memories`,
  });
}
