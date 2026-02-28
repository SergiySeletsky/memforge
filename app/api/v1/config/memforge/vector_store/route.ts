/**
 * GET/PUT /api/v1/config/memforge/vector_store
 * Spec 00: Memgraph port - vector store is now Memgraph, return its config.
 */
import { NextRequest, NextResponse } from "next/server";
import { runRead, runWrite } from "@/lib/db/memgraph";

const CONFIG_KEY = "mem0_vector_store";
const DEFAULT = { provider: "memgraph", config: { url: process.env.MEMGRAPH_URL ?? "bolt://localhost:7687" } };

export async function GET() {
  const rows = await runRead<{ value: string }>(`MATCH (c:Config {key: $key}) RETURN c.value AS value`, { key: CONFIG_KEY });
  if (!rows.length) return NextResponse.json(DEFAULT);
  try { return NextResponse.json(JSON.parse(rows[0].value)); } catch { return NextResponse.json(DEFAULT); }
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  await runWrite(`MERGE (c:Config {key: $key}) SET c.value = $value`, { key: CONFIG_KEY, value: JSON.stringify(body) });
  return NextResponse.json(body);
}
