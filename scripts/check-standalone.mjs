// Fails the build if dist references Ploid's private packages or the type-only contracts file.
import { readdirSync, readFileSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
const offenders = readdirSync(dist)
    .filter((file) => /\.(?:js|d\.ts)$/.test(file))
    .filter((file) => /["'](?:@ploid\/|\.\/contracts\.js)/.test(readFileSync(new URL(file, dist), "utf8")));

if (offenders.length > 0) {
    process.stderr.write(`dist references a private package or ./contracts.js: ${offenders.join(", ")}\n`);
    process.exit(1);
}
