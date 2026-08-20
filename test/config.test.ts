import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, saveCredentials } from "../src/config.js";

const originalConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
});

describe("local credential storage", () => {
  it("atomically replaces an existing config with a private credential file", () => {
    const root = mkdtempSync(join(tmpdir(), "ploid-mcp-config-"));
    process.env.XDG_CONFIG_HOME = root;
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n");
    chmodSync(path, 0o644);

    try {
      saveCredentials("ploid_test_key", "https://api.ploid.com");
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ api_key: "ploid_test_key" });
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dirname(path))).toEqual(["config.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
