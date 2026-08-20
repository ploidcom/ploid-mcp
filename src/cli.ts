import { browserLogin } from "./device.js";
import { clearCredentials, resolveConfig, saveCredentials } from "./config.js";
import { revokeApiKey } from "./logout.js";
import { serveMcp } from "./server.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "login") {
    const config = resolveConfig();
    const apiKey = await browserLogin(config.baseUrl, !process.argv.includes("--no-browser"));
    const path = saveCredentials(apiKey, config.baseUrl);
    process.stdout.write(`Ploid MCP connected. Credentials saved to ${path}\n`);
    return;
  }
  if (command === "logout") {
    const config = resolveConfig();
    const revoked = config.apiKey ? await revokeApiKey(config.baseUrl, config.apiKey) : false;
    const removed = clearCredentials();
    process.stdout.write(
      revoked
        ? "Ploid MCP disconnected. API key revoked and local credentials removed.\n"
        : removed || config.apiKey
          ? "Ploid MCP local credentials removed. The API key could not be revoked; remove it from your Ploid account if this machine was lost.\n"
          : "No saved Ploid credentials found.\n",
    );
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write("Usage:\n  ploid-mcp login [--no-browser]\n  ploid-mcp logout\n  ploid-mcp        Start the MCP stdio server\n");
    return;
  }
  await serveMcp();
}

main().catch((error) => {
  process.stderr.write(`Ploid MCP error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
