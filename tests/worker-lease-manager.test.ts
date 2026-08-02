import { describe, expect, it, vi } from "vitest";
import { retryLeaseRenewal } from "@/worker/lease-manager";

describe("worker lease renewal", () => {
  it("recovers from one transient database error", async () => {
    const renewal = vi.fn()
      .mockRejectedValueOnce(new Error("temporary database error"))
      .mockResolvedValueOnce(true);

    await expect(retryLeaseRenewal(renewal, { retryDelayMs: 0 })).resolves.toBe(true);
    expect(renewal).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the bounded retry is exhausted", async () => {
    const renewal = vi.fn().mockRejectedValue(new Error("database unavailable"));

    await expect(retryLeaseRenewal(renewal, { retryDelayMs: 0 }))
      .rejects.toThrow("LEASE_RENEWAL_UNCONFIRMED");
    expect(renewal).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when the task is cancelled", async () => {
    const controller = new AbortController();
    const renewal = vi.fn(async () => {
      controller.abort(new Error("WORKER_SHUTDOWN"));
      throw new Error("database unavailable");
    });

    await expect(retryLeaseRenewal(renewal, {
      retryDelayMs: 1,
      signal: controller.signal,
    })).rejects.toThrow("WORKER_SHUTDOWN");
    expect(renewal).toHaveBeenCalledTimes(1);
  });
});
