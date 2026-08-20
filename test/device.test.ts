import { afterEach, describe, expect, it, vi } from "vitest";
import { browserLogin } from "../src/device.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("device login polling", () => {
  it("honors backoff and retries a transient token error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: "device_1",
        user_code: "ABCD-EFGH",
        verification_uri_complete: "https://ploid.com/auth/cli?code=ABCD-EFGH",
        expires_in: 60,
        interval: 1,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Try again" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "2" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "approved", api_key: "ploid_test_key" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = browserLogin("https://api.ploid.test", false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toBe("ploid_test_key");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
