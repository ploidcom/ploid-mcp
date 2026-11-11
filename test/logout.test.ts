import { describe, expect, it } from "vitest";
import { revokeApiKey } from "../src/logout.js";

describe("logout", () => {
    it("revokes the device API key through the account endpoint", async () => {
        const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
            expect(String(input)).toBe("https://api.example.test/v1/account/key");
            expect(init).toMatchObject({ method: "DELETE", headers: { Authorization: "Bearer ploid_test_key", Accept: "application/json" } });
            return new Response(null, { status: 200 });
        };

        await expect(revokeApiKey("https://api.example.test", "ploid_test_key", fetchMock)).resolves.toBe(true);
    });
});
