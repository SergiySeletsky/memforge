/**
 * GET /api/v1/config/mem0/embedder — get embedder config
 * PUT /api/v1/config/mem0/embedder — update embedder config
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfigFromDb, saveConfigToDb } from "@/lib/config/helpers";
import { resetMemoryClient } from "@/lib/mem0/client";

export async function GET() {
  const config = getConfigFromDb();
  return NextResponse.json(config.mem0?.embedder || {});
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const config = getConfigFromDb();
  if (!config.mem0) config.mem0 = {} as any;
  config.mem0.embedder = body;
  saveConfigToDb(config);
  resetMemoryClient();
  return NextResponse.json(config.mem0.embedder);
}
