/**
 * xAI / Grok LLM — OpenAI-compatible via base_url.
 * Port of Python mem0.llms.xai.XAILLM.
 */
import OpenAI from "openai";
import { LLM, LLMResponse } from "./base";
import { LLMConfig, Message } from "../types";

export class XAILLM implements LLM {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    const apiKey = config.apiKey ?? process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "xAI API key is required. Set XAI_API_KEY env or pass apiKey in config.",
      );
    }
    const baseURL =
      config.baseURL ??
      process.env.XAI_API_BASE ??
      "https://api.x.ai/v1";
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = config.model ?? "grok-2-latest";
  }

  async generateResponse(
    messages: Message[],
    responseFormat?: { type: string },
  ): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((msg) => ({
        role: msg.role as "system" | "user" | "assistant",
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      })),
      ...(responseFormat && {
        response_format: responseFormat as { type: "text" | "json_object" },
      }),
    });

    return completion.choices[0].message.content ?? "";
  }

  async generateChat(messages: Message[]): Promise<LLMResponse> {
    const content = await this.generateResponse(messages);
    return { content, role: "assistant" };
  }
}
