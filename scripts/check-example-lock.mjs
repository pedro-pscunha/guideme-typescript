// examples/otlp/bun.lock records this package's own dependency specifiers in the entry for its
// `file:` dependency, and bun 1.4.2's `--frozen-lockfile` does not notice when they go stale:
// the example's install passes and quietly keeps the old ones. This compares that entry with
// the root package.json, so a change to the library's dependencies cannot leave it behind.
import { readFileSync } from "node:fs";

const LOCK = "examples/otlp/bun.lock";
const FIELDS = ["dependencies", "peerDependencies", "devDependencies"];

const manifest = JSON.parse(readFileSync("package.json", "utf8"));

// bun.lock is JSON with trailing commas. Dropping each comma that closes an object or an
// array leaves plain JSON: the lock's strings are names, versions, ranges and hashes, and none
// of them holds a comma followed by a bracket.
const lock = JSON.parse(readFileSync(LOCK, "utf8").replace(/,(\s*[}\]])/gu, "$1"));
const entry = lock.packages?.[manifest.name];
if (!Array.isArray(entry) || typeof entry[1] !== "object" || entry[1] === null) {
  console.error(`${LOCK} has no entry for ${manifest.name}; the example no longer links it`);
  process.exit(1);
}

/** A specifier map with its keys sorted, so key order never counts as a difference. */
const sorted = (map) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(map ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))),
  );

const stale = FIELDS.filter((field) => sorted(manifest[field]) !== sorted(entry[1][field]));
for (const field of stale) {
  console.error(
    `${LOCK} records ${field} ${sorted(entry[1][field])}; package.json has ${sorted(manifest[field])}`,
  );
}
if (stale.length > 0) {
  console.error(
    `regenerate it: build, then in examples/otlp run \`rm -rf bun.lock node_modules && bun install\``,
  );
  process.exit(1);
}

console.log(`${LOCK} records the ${FIELDS.join(", ")} package.json declares`);
