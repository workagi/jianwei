import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWriteAuth: mocks.auth }));
vi.mock("@/lib/event-reader", () => ({ updateEventReaderState: mocks.update }));
import { POST } from "@/app/api/events/state/route";

describe("event state write boundary", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue(null); mocks.update.mockResolvedValue("ok"); });
  const request = (body: unknown) => new Request("http://localhost/api/events/state", { method: "POST", body: JSON.stringify(body) });
  it("rejects unauthenticated writes before reading or mutating state", async () => {
    mocks.auth.mockResolvedValue(new Response("denied", { status: 401 }));
    expect((await POST(request({}))).status).toBe(401); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects malformed and empty state changes", async () => {
    expect((await POST(request({ eventId: "bad", readRevision: -1 }))).status).toBe(400);
    expect((await POST(request({ eventId: "00000000-0000-4000-8000-000000000001" }))).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("passes only the displayed revision and returns conflict for a future revision", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect((await POST(request({ eventId: id, readRevision: 3 }))).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(id, { readRevision: 3 });
    mocks.update.mockResolvedValue("invalid_revision");
    expect((await POST(request({ eventId: id, readRevision: 100 }))).status).toBe(409);
  });
});
