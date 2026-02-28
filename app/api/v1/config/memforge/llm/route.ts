/**
 * /api/v1/config/memforge/llm — removed.
 * LLM is configured exclusively via Azure AI Foundry environment variables
 * (LLM_AZURE_OPENAI_API_KEY, LLM_AZURE_ENDPOINT, LLM_AZURE_DEPLOYMENT).
 * This endpoint is no longer writable.
 */
import { NextResponse } from "next/server";

const MSG = { detail: "LLM configuration is managed via environment variables and cannot be changed at runtime." };

export async function GET() { return NextResponse.json(MSG, { status: 410 }); }
export async function PUT() { return NextResponse.json(MSG, { status: 410 }); }
