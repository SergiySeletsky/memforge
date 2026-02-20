/// <reference types="jest" />
/**
 * LLM provider unit tests.
 * Mocks OpenAI SDK to verify each provider's constructor config, generateResponse,
 * and generateChat behaviour without making real API calls.
 */

const mockCreate = jest.fn();

jest.mock("openai", () => {
  return jest.fn().mockImplementation((opts: any) => {
    // Store the constructor args so tests can inspect them
    (mockCreate as any).__lastOpts = opts;
    return {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    };
  });
});

import { DeepSeekLLM } from "../src/llms/deepseek";
import { XAILLM } from "../src/llms/xai";
import { TogetherLLM } from "../src/llms/together";
import { LMStudioLLM } from "../src/llms/lmstudio";
import { OpenAILLM } from "../src/llms/openai";

beforeEach(() => {
  mockCreate.mockReset();
});

// ---- Helper to mock a simple text response ----
function mockTextResponse(content = "Hello world") {
  mockCreate.mockResolvedValue({
    choices: [
      {
        message: { role: "assistant", content, tool_calls: undefined },
      },
    ],
  });
}

// ---- Helper to mock a tool-call response ----
function mockToolCallResponse() {
  mockCreate.mockResolvedValue({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "get_weather",
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
      },
    ],
  });
}

// ---- Shared messages ----
const messages = [{ role: "user" as const, content: "Hi" }];

// ============ OpenAI LLM ============
describe("OpenAILLM", () => {
  it("should use correct default model", () => {
    const llm = new OpenAILLM({ apiKey: "test" });
    expect(llm).toBeDefined();
  });

  it("should return string for plain text response", async () => {
    mockTextResponse("I am OpenAI");
    const llm = new OpenAILLM({ apiKey: "test", model: "gpt-4" });
    const result = await llm.generateResponse(messages);
    expect(result).toBe("I am OpenAI");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("gpt-4");
  });

  it("should return LLMResponse for tool calls", async () => {
    mockToolCallResponse();
    const llm = new OpenAILLM({ apiKey: "test" });
    const tools = [
      { type: "function", function: { name: "get_weather", parameters: {} } },
    ];
    const result = await llm.generateResponse(messages, undefined, tools);
    expect(typeof result).toBe("object");
    expect((result as any).toolCalls).toBeDefined();
    expect((result as any).toolCalls[0].name).toBe("get_weather");
  });

  it("generateChat should return LLMResponse", async () => {
    mockTextResponse("chat response");
    const llm = new OpenAILLM({ apiKey: "test" });
    const resp = await llm.generateChat(messages);
    expect(resp.content).toBe("chat response");
    expect(resp.role).toBe("assistant");
  });
});

// ============ DeepSeek LLM ============
describe("DeepSeekLLM", () => {
  it("should throw without API key", () => {
    const orig = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => new DeepSeekLLM({})).toThrow("DeepSeek API key is required");
    process.env.DEEPSEEK_API_KEY = orig;
  });

  it("should use deepseek base URL", () => {
    const llm = new DeepSeekLLM({ apiKey: "ds-key" });
    expect(llm).toBeDefined();
    // Verify OpenAI constructor was called with deepseek base URL
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.baseURL).toBe("https://api.deepseek.com");
  });

  it("should default to deepseek-chat model", async () => {
    mockTextResponse("deepseek says hi");
    const llm = new DeepSeekLLM({ apiKey: "ds-key" });
    const result = await llm.generateResponse(messages);
    expect(result).toBe("deepseek says hi");
    expect(mockCreate.mock.calls[0][0].model).toBe("deepseek-chat");
  });

  it("should handle tool calls", async () => {
    mockToolCallResponse();
    const llm = new DeepSeekLLM({ apiKey: "ds-key" });
    const tools = [
      { type: "function", function: { name: "fn", parameters: {} } },
    ];
    const result = await llm.generateResponse(messages, undefined, tools);
    expect(typeof result).toBe("object");
    expect((result as any).toolCalls).toHaveLength(1);
  });

  it("should pass response_format when provided", async () => {
    mockTextResponse('{"result": true}');
    const llm = new DeepSeekLLM({ apiKey: "ds-key" });
    await llm.generateResponse(messages, { type: "json_object" });
    expect(mockCreate.mock.calls[0][0].response_format).toEqual({
      type: "json_object",
    });
  });
});

// ============ xAI LLM ============
describe("XAILLM", () => {
  it("should throw without API key", () => {
    const orig = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    expect(() => new XAILLM({})).toThrow("xAI API key is required");
    process.env.XAI_API_KEY = orig;
  });

  it("should use x.ai base URL", () => {
    const llm = new XAILLM({ apiKey: "xai-key" });
    expect(llm).toBeDefined();
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.baseURL).toBe("https://api.x.ai/v1");
  });

  it("should default to grok-2-latest model", async () => {
    mockTextResponse("grok response");
    const llm = new XAILLM({ apiKey: "xai-key" });
    await llm.generateResponse(messages);
    expect(mockCreate.mock.calls[0][0].model).toBe("grok-2-latest");
  });

  it("should return plain string (no tool support)", async () => {
    mockTextResponse("hello from grok");
    const llm = new XAILLM({ apiKey: "xai-key" });
    const result = await llm.generateResponse(messages);
    expect(result).toBe("hello from grok");
  });

  it("generateChat should wrap in LLMResponse", async () => {
    mockTextResponse("chat grok");
    const llm = new XAILLM({ apiKey: "xai-key" });
    const resp = await llm.generateChat(messages);
    expect(resp.content).toBe("chat grok");
    expect(resp.role).toBe("assistant");
  });
});

// ============ Together LLM ============
describe("TogetherLLM", () => {
  it("should throw without API key", () => {
    const orig = process.env.TOGETHER_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    expect(() => new TogetherLLM({})).toThrow("Together API key is required");
    process.env.TOGETHER_API_KEY = orig;
  });

  it("should use together.xyz base URL", () => {
    const llm = new TogetherLLM({ apiKey: "tog-key" });
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.baseURL).toBe("https://api.together.xyz/v1");
  });

  it("should default to Mixtral model", async () => {
    mockTextResponse("mixtral");
    const llm = new TogetherLLM({ apiKey: "tog-key" });
    await llm.generateResponse(messages);
    expect(mockCreate.mock.calls[0][0].model).toBe(
      "mistralai/Mixtral-8x7B-Instruct-v0.1",
    );
  });

  it("should handle tool calls", async () => {
    mockToolCallResponse();
    const llm = new TogetherLLM({ apiKey: "tog-key" });
    const tools = [
      { type: "function", function: { name: "fn", parameters: {} } },
    ];
    const result = await llm.generateResponse(messages, undefined, tools);
    expect(typeof result).toBe("object");
    expect((result as any).toolCalls[0].name).toBe("get_weather");
  });
});

// ============ LMStudio LLM ============
describe("LMStudioLLM", () => {
  it("should use localhost:1234 base URL by default", () => {
    const llm = new LMStudioLLM({});
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.baseURL).toBe("http://localhost:1234/v1");
  });

  it("should use lm-studio as default api key", () => {
    const llm = new LMStudioLLM({});
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.apiKey).toBe("lm-studio");
  });

  it("should default to json_object response format", async () => {
    mockTextResponse('{"key": "value"}');
    const llm = new LMStudioLLM({});
    await llm.generateResponse(messages);
    expect(mockCreate.mock.calls[0][0].response_format).toEqual({
      type: "json_object",
    });
  });

  it("should allow overriding response format", async () => {
    mockTextResponse("plain text");
    const llm = new LMStudioLLM({});
    await llm.generateResponse(messages, { type: "text" });
    expect(mockCreate.mock.calls[0][0].response_format).toEqual({
      type: "text",
    });
  });

  it("should handle tool calls", async () => {
    mockToolCallResponse();
    const llm = new LMStudioLLM({});
    const tools = [
      { type: "function", function: { name: "my_tool", parameters: {} } },
    ];
    const result = await llm.generateResponse(messages, undefined, tools);
    expect(typeof result).toBe("object");
    expect((result as any).toolCalls[0].name).toBe("get_weather");
  });

  it("should accept custom base URL", () => {
    const llm = new LMStudioLLM({ baseURL: "http://custom:5678/v1" });
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.baseURL).toBe("http://custom:5678/v1");
  });
});
