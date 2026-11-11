import type { DeviceAuthTokenResponse } from "../src/contracts.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceAuthError, browserLogin, startDeviceAuth, waitForDeviceApproval } from "../src/device.js";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const APPROVED: DeviceAuthTokenResponse = {
    status: "approved",
    api_key: "ploid_live_abc",
    key_prefix: "ploid_live_abc",
    scopes: ["people:search"],
    organization_id: "org_1",
    expires_at: "2026-11-05T00:00:00.000Z",
};

function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });
}

function tokenResponses(...responses: Response[]) {
    const fetchMock = vi.fn();
    for (const response of responses) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    const sleeps: number[] = [];
    const clock = {
        sleep: async (ms: number) => {
            sleeps.push(ms);
        },
        now: () => 1_000,
    };
    return { fetchMock, sleeps, clock };
}

const START = { device_code: "dc", expires_in: 900, interval: 5 };

describe("device login polling", () => {
    it("honors backoff and retries a transient token error", async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                json({
                    device_code: "device_1",
                    user_code: "ABCD-EFGH",
                    verification_uri: "https://ploid.com/auth/cli",
                    verification_uri_complete: "https://ploid.com/auth/cli?code=ABCD-EFGH",
                    expires_in: 60,
                    interval: 1,
                }),
            )
            .mockResolvedValueOnce(json({ message: "Try again" }, { status: 503, headers: { "retry-after": "2" } }))
            .mockResolvedValueOnce(json({ ...APPROVED, api_key: "ploid_test_key" }));
        vi.stubGlobal("fetch", fetchMock);

        const result = browserLogin("https://api.ploid.test", false);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe("ploid_test_key");
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("scopes");
    });

    it("resolves with the approved token after pending polls", async () => {
        const { fetchMock, clock } = tokenResponses(json({ status: "pending", interval: 5 }), json({ status: "pending", interval: 5 }), json(APPROVED));
        await expect(waitForDeviceApproval("https://api.ploid.test/", START, clock)).resolves.toMatchObject({ api_key: "ploid_live_abc" });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.ploid.test/api/auth/device/token");
    });

    it("backs off the interval on slow_down", async () => {
        const { sleeps, clock } = tokenResponses(json({ status: "slow_down", interval: 5 }), json(APPROVED));
        await waitForDeviceApproval("https://api.ploid.test", START, clock);
        expect(sleeps).toEqual([5_000, 7_000]);
    });

    it("sends caller headers on every request", async () => {
        const { fetchMock, clock } = tokenResponses(json(APPROVED));
        await waitForDeviceApproval("https://api.ploid.test", START, { ...clock, headers: { "User-Agent": "ploid-cli/test" } });
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "User-Agent": "ploid-cli/test", Accept: "application/json" });
    });

    it.each([
        [{ status: "denied" }, "denied"],
        [{ status: "expired" }, "expired"],
        [{ status: "surprise" }, "http"],
    ])("stops on %o", async (body, reason) => {
        const { clock } = tokenResponses(json(body));
        await expect(waitForDeviceApproval("https://api.ploid.test", START, clock)).rejects.toMatchObject({ reason });
    });

    it("fails on a non-transient HTTP error without retrying", async () => {
        const { fetchMock, clock } = tokenResponses(json({ message: "Bad device code" }, { status: 400 }));
        const error = await waitForDeviceApproval("https://api.ploid.test", START, clock).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(DeviceAuthError);
        expect(error).toMatchObject({ reason: "http", status: 400, message: "Bad device code" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("expires without polling once the deadline has passed", async () => {
        const { fetchMock, clock } = tokenResponses(json(APPROVED));
        await expect(waitForDeviceApproval("https://api.ploid.test", { ...START, expires_in: 0 }, clock)).rejects.toMatchObject({ reason: "expired" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports an unreachable API as a network failure", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
        await expect(startDeviceAuth("https://api.ploid.test", "laptop")).rejects.toMatchObject({
            reason: "network",
            message: "Could not reach the Ploid API at https://api.ploid.test/api/auth/device/start: fetch failed",
        });
    });
});
