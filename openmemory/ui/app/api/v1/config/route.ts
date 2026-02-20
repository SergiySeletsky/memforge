/**
 * GET /api/v1/config — get full configuration
 * PUT /api/v1/config — replace full configuration
 * PATCH /api/v1/config — partial update configuration
 *
 * Port of openmemory/api/app/routers/config.py (GET/PUT/PATCH /)
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getConfigFromDb,
  saveConfigToDb,
  getDefaultConfiguration,
  deepUpdate,
} from "@/lib/config/helpers";
import { resetMemoryClient } from "@/lib/mem0/client";

export async function GET() {
  const config = getConfigFromDb();
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const current = getConfigFromDb();
  const updated = { ...current };

  if (body.openmemory) {
    updated.openmemory = { ...updated.openmemory, ...body.openmemory };
  }
  if (body.mem0) {
    updated.mem0 = body.mem0;
  }

  saveConfigToDb(updated);
  resetMemoryClient();
  return NextResponse.json(updated);
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const current = getConfigFromDb();
  const updated = deepUpdate(current, body);

  saveConfigToDb(updated);
  resetMemoryClient();
  return NextResponse.json(updated);
}
