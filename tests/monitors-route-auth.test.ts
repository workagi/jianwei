import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWriteAuth: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  orderBy: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireWriteAuth: mocks.requireWriteAuth }));
vi.mock("@/db", () => ({ db: { select: mocks.select } }));

import { GET } from "@/app/api/monitors/route";

describe("GET /api/monitors", () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://test";
    mocks.requireWriteAuth.mockReset();
    mocks.select.mockReset();
    mocks.from.mockReset();
    mocks.orderBy.mockReset();
    mocks.orderBy.mockResolvedValue([]);
    mocks.from.mockReturnValue({ orderBy: mocks.orderBy });
    mocks.select.mockReturnValue({ from: mocks.from });
  });

  afterEach(() => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("rejects an unauthenticated read before querying the database", async () => {
    mocks.requireWriteAuth.mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 401 }));

    const response = await GET(new Request("http://localhost/api/monitors"));

    expect(response.status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("returns only the explicit administrative projection after authentication", async () => {
    mocks.requireWriteAuth.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/monitors"));
    const projection = mocks.select.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(projection)).toEqual([
      "id",
      "platform",
      "name",
      "config",
      "enabled",
      "pollIntervalMinutes",
      "lastSuccessAt",
      "nextRunAt",
      "failureCount",
      "lastError",
      "createdAt",
      "updatedAt",
    ]);
    expect(projection).not.toHaveProperty("cursor");
    expect(projection).not.toHaveProperty("leaseOwner");
    expect(projection).not.toHaveProperty("leaseEpoch");
  });
});
