/**
 * GET /api/v1/config/openmemory — get OpenMemory-specific config
 * PUT /api/v1/config/openmemory — update OpenMemory-specific config
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfigFromDb, saveConfigToDb } from "@/lib/config/helpers";
import { resetMemoryClient } from "@/lib/mem0/client";

export async function GET() {
  const config = getConfigFromDb();
  return NextResponse.json(config.openmemory || {});
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const config = getConfigFromDb();
  if (!config.openmemory) config.openmemory = {} as any;
  Object.assign(config.openmemory, body);
  saveConfigToDb(config);
  resetMemoryClient();
  return NextResponse.json(config.openmemory);
}
