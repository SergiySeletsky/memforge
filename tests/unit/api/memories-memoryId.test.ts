/**
 * P8 â€” app/api/v1/memories/[memoryId]/route.ts unit tests
 *
 * Covers: GET (400/404/200), PUT (400/404/200)
 */
export {};

// ---- Mocks ----
const mockRunRead = jest.fn();
jest.mock("@/lib/db/memgraph", () => ({
  runRead: (...args: unknown[]) => mockRunRead(...args),
}));

const mockSupersede = jest.fn();
jest.mock("@/lib/memory/write", () => ({
  supersedeMemory: (...args: unknown[]) => mockSupersede(...args),
}));

import { GET, PUT } from "@/app/api/v1/memories/[memoryId]/route";
import { NextRequest } from "next/server";

// Helper: create a mock NextRequest
function makeRequest(
  method: string,
  url: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>
) {
  const req = new NextRequest(url, {
    method,
    headers: headers ? new Headers(headers) : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return req;
}

function makeParams(memoryId: string) {
  return { params: Promise.resolve({ memoryId }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRunRead.mockResolvedValue([]);
  mockSupersede.mockResolvedValue("new-id");
});

// ==========================================================================
// GET /api/v1/memories/:memoryId
// ==========================================================================
describe("GET /api/v1/memories/:memoryId", () => {
  test("RT_01: returns 400 when user_id is missing", async () => {
    const req = makeRequest("GET", "http://localhost:3000/api/v1/memories/mem-1");
    const res = await GET(req, makeParams("mem-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("user_id");
  });

  test("RT_02: returns 400 when user_id is blank string", async () => {
    const req = makeRequest(
      "GET",
      "http://localhost:3000/api/v1/memories/mem-1?user_id=%20"
    );
    const res = await GET(req, makeParams("mem-1"));
    expect(res.status).toBe(400);
  });

  test("RT_03: returns 404 when memory not found", async () => {
    mockRunRead.mockResolvedValue([]);
    const req = makeRequest(
      "GET",
      "http://localhost:3000/api/v1/memories/mem-1?user_id=u1"
    );
    const res = await GET(req, makeParams("mem-1"));
    expect(res.status).toBe(404);
  });

  test("RT_04: returns 200 with memory shape", async () => {
    mockRunRead.mockResolvedValue([{
      id: "mem-1",
      content: "hello world",
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: '{"key":"val"}',
      validAt: "2026-01-01T00:00:00.000Z",
      invalidAt: null,
      appName: "test-app",
      categories: ["Personal"],
      supersededBy: null,
    }]);
    const req = makeRequest(
      "GET",
      "http://localhost:3000/api/v1/memories/mem-1?user_id=u1"
    );
    const res = await GET(req, makeParams("mem-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("mem-1");
    expect(body.text).toBe("hello world");
    expect(body.state).toBe("active");
    expect(body.app_name).toBe("test-app");
    expect(body.categories).toEqual(["Personal"]);
    expect(body.is_current).toBe(true);
    expect(body.metadata_).toEqual({ key: "val" });
  });

  test("RT_05: accepts user_id from x-user-id header", async () => {
    mockRunRead.mockResolvedValue([{
      id: "mem-1",
      content: "hi",
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: "{}",
      appName: null,
      categories: [],
      supersededBy: null,
    }]);
    const req = makeRequest(
      "GET",
      "http://localhost:3000/api/v1/memories/mem-1",
      undefined,
      { "x-user-id": "u1" }
    );
    const res = await GET(req, makeParams("mem-1"));
    expect(res.status).toBe(200);
  });
});

// ==========================================================================
// PUT /api/v1/memories/:memoryId
// ==========================================================================
describe("PUT /api/v1/memories/:memoryId", () => {
  test("RT_10: returns 400 when text is missing", async () => {
    const req = makeRequest(
      "PUT",
      "http://localhost:3000/api/v1/memories/mem-1",
      { user_id: "u1" }
    );
    const res = await PUT(req, makeParams("mem-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("required");
  });

  test("RT_11: returns 400 when user_id is missing", async () => {
    const req = makeRequest(
      "PUT",
      "http://localhost:3000/api/v1/memories/mem-1",
      { text: "new text" }
    );
    const res = await PUT(req, makeParams("mem-1"));
    expect(res.status).toBe(400);
  });

  test("RT_12: returns 404 when ownership check fails", async () => {
    mockRunRead.mockResolvedValueOnce([]); // ownership check â†’ empty
    const req = makeRequest(
      "PUT",
      "http://localhost:3000/api/v1/memories/mem-1",
      { text: "new text", user_id: "u1" }
    );
    const res = await PUT(req, makeParams("mem-1"));
    expect(res.status).toBe(404);
  });

  test("RT_13: returns 200 with new memory after successful supersession", async () => {
    // First read: ownership check passes
    mockRunRead.mockResolvedValueOnce([{ id: "mem-1" }]);
    // Second read: fetch new node
    mockRunRead.mockResolvedValueOnce([{
      id: "new-id",
      content: "updated text",
      state: "active",
      createdAt: "2026-01-02T00:00:00.000Z",
      validAt: "2026-01-02T00:00:00.000Z",
      metadata: "{}",
      appName: "memforge",
      categories: [],
    }]);
    mockSupersede.mockResolvedValue("new-id");

    const req = makeRequest(
      "PUT",
      "http://localhost:3000/api/v1/memories/mem-1",
      { text: "updated text", user_id: "u1" }
    );
    const res = await PUT(req, makeParams("mem-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("new-id");
    expect(body.content).toBe("updated text");
    expect(body.is_current).toBe(true);
  });

  test("RT_14: calls supersedeMemory with correct args", async () => {
    mockRunRead.mockResolvedValueOnce([{ id: "mem-1" }]);
    mockRunRead.mockResolvedValueOnce([{
      id: "new-id",
      content: "text",
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);

    const req = makeRequest(
      "PUT",
      "http://localhost:3000/api/v1/memories/mem-1",
      { text: "updated", user_id: "u1", app_name: "cursor" }
    );
    await PUT(req, makeParams("mem-1"));

    expect(mockSupersede).toHaveBeenCalledWith(
      "mem-1",
      "updated",
      "u1",
      "cursor"
    );
  });
});
