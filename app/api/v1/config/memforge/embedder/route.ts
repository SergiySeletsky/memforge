/**
 * /api/v1/config/memforge/embedder — removed.
 * Embedder is configured exclusively via Azure AI Foundry environment variables
 * (EMBEDDING_AZURE_OPENAI_API_KEY, EMBEDDING_AZURE_ENDPOINT, EMBEDDING_AZURE_DEPLOYMENT).
 * This endpoint is no longer writable.
 */
import { NextResponse } from "next/server";

const MSG = { detail: "Embedder configuration is managed via environment variables and cannot be changed at runtime." };

export async function GET() { return NextResponse.json(MSG, { status: 410 }); }
export async function PUT() { return NextResponse.json(MSG, { status: 410 }); }
