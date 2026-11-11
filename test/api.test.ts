import { describe, expect, it } from "vitest";
import { PloidApiError, PloidNetworkError, PloidRunEndedError, isTransient } from "../src/api.js";

describe("isTransient", () => {
    it("retries rate limits, server errors, network failures and timeouts", () => {
        expect(isTransient(new PloidApiError("Bad gateway", 502))).toBe(true);
        expect(isTransient(new PloidApiError("Slow down", 429))).toBe(true);
        expect(isTransient(new PloidNetworkError(new TypeError("fetch failed")))).toBe(true);
        expect(isTransient(new DOMException("Request timed out", "TimeoutError"))).toBe(true);
        expect(isTransient(new DOMException("Aborted", "AbortError"))).toBe(true);
    });

    it("does not retry client errors or TypeErrors thrown by code", () => {
        expect(isTransient(new PloidApiError("Expired", 410))).toBe(false);
        expect(isTransient(new TypeError("Cannot read properties of undefined"))).toBe(false);
        expect(isTransient(new Error("Ploid returned an invalid response (200)."))).toBe(false);
    });

    it("does not retry a run that has ended, whatever status the API used", () => {
        const failed = new PloidApiError("The person profile is temporarily unavailable.", 503, "person_unavailable");
        expect(isTransient(new PloidRunEndedError(failed.message, { cause: failed }))).toBe(false);
    });
});
