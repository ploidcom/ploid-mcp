import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", server: "src/server.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
});
