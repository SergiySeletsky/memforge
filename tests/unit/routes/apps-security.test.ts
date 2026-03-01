export {};
/**
 * Unit tests — app/api/v1/apps/[appId]/route.ts security fixes
 *
 * APPS_SEC_01: GET requires user_id query param
 * APPS_SEC_02: GET anchors App lookup through User node (Spec 09)
 * APPS_SEC_03: PUT requires user_id query param
 * APPS_SEC_04: PUT anchors App update through User node (Spec 09)
 */

const mockRunRead = jest.fn();
const mockRunWrite = jest.fn();

jest.mock("@/lib/db/memgraph", () => ({
  runRead: (...args: unknown[]) => mockRunRead(...args),
  runWrite: (...args: unknown[]) => mockRunWrite(...args),
}));

import { GET, PUT } from "@/app/api/v1/apps/[appId]/route";
import { NextRequest } from "next/server";

function makeRequest(url: string, body?: unknown) {
  if (body) {
    return new NextRequest(new URL(url, "http://localhost:3000"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

const params = Promise.resolve({ appId: "test-app" });

beforeEach(() => {
  jest.clearAllMocks();
  mockRunRead.mockResolvedValue([]);
  mockRunWrite.mockResolvedValue([]);
});

describe("GET /api/v1/apps/[appId]", () => {
  it("APPS_SEC_01: returns 400 when user_id missing", async () => {
    const req = makeRequest("http://localhost:3000/api/v1/apps/test-app");
    const res = await GET(req, { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("user_id");
  });

  it("APPS_SEC_02: anchors App lookup through User node (Spec 09)", async () => {
    mockRunRead.mockResolvedValueOnce([
      { name: "test-app", id: "a1", is_active: true, created_at: "2026-01-01", memory_count: 0 },
    ]);
    const req = makeRequest("http://localhost:3000/api/v1/apps/test-app?user_id=u1");
    await GET(req, { params });

    const cypher = mockRunRead.mock.calls[0][0] as string;
    // Must start from User→HAS_APP→App (not bare App match)
    expect(cypher).toContain("User {userId: $userId}");
    expect(cypher).toContain("[:HAS_APP]->");
    expect(cypher).toContain(":App");
  });
});

describe("PUT /api/v1/apps/[appId]", () => {
  it("APPS_SEC_03: returns 400 when user_id missing", async () => {
    const req = makeRequest("http://localhost:3000/api/v1/apps/test-app", { is_active: false });
    const res = await PUT(req, { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("user_id");
  });

  it("APPS_SEC_04: anchors App update through User node (Spec 09)", async () => {
    const req = makeRequest("http://localhost:3000/api/v1/apps/test-app?user_id=u1", { is_active: false });
    await PUT(req, { params });

    const cypher = mockRunWrite.mock.calls[0][0] as string;
    expect(cypher).toContain("User {userId: $userId}");
    expect(cypher).toContain("[:HAS_APP]->");
    expect(cypher).toContain(":App {appName: $appId}");
    // Verify userId is passed in params
    const writeParams = mockRunWrite.mock.calls[0][1] as Record<string, unknown>;
    expect(writeParams.userId).toBe("u1");
  });
});
