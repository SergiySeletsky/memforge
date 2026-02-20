/**
 * POST /api/v1/config/reset — reset to default configuration
 *
 * Port of openmemory/api/app/routers/config.py (POST /reset)
 */
import { NextResponse } from "next/server";
import { getDefaultConfiguration, saveConfigToDb } from "@/lib/config/helpers";
import { resetMemoryClient } from "@/lib/mem0/client";

export async function POST() {
  try {
    const defaultConfig = getDefaultConfiguration();
    saveConfigToDb(defaultConfig);
    resetMemoryClient();
    return NextResponse.json(defaultConfig);
  } catch (e: any) {
    return NextResponse.json(
      { detail: `Failed to reset configuration: ${e.message}` },
      { status: 500 }
    );
  }
}
