// The published surface, read from what ships: every name `dist/index.d.ts` exports, compared
// with `scripts/exports.txt`. Run after `mise run build`.
//
// `test/surface.test.ts` pins the runtime values and `test/typing.test-d.ts` fails to compile
// when a listed type disappears, but neither notices a type being ADDED: a module namespace
// carries no types, and a tuple of named types says nothing about the names it does not list.
// This does, and it reads the emitted declarations, so it also sees what `tsc` actually wrote.
import { readFileSync } from "node:fs";

const dts = readFileSync("dist/index.d.ts", "utf8");

// Every statement in the entry point must be an `export { .. } from ".."`. Any other export
// form would be a way onto the surface this parser does not read, so it is refused rather
// than skipped.
const statements = dts
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .replace(/^\s*\/\/.*$/gmu, "")
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const found = [];
const refused = [];
for (const statement of statements) {
  const m = /^export\s*\{([^}]*)\}\s*from\s*"[^"]+"$/u.exec(statement);
  if (m === null) {
    refused.push(statement);
    continue;
  }
  for (const part of m[1].split(",")) {
    const name = part.trim().replace(/\s+/gu, " ");
    if (name.length > 0) found.push(name);
  }
}

const expected = readFileSync("scripts/exports.txt", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

const missing = expected.filter((n) => !found.includes(n));
const unexpected = found.filter((n) => !expected.includes(n));

for (const s of refused) console.error(`not an \`export { .. } from\`: ${s}`);
for (const n of missing) console.error(`listed in scripts/exports.txt, not exported: ${n}`);
for (const n of unexpected) console.error(`exported, not listed in scripts/exports.txt: ${n}`);
if (refused.length + missing.length + unexpected.length > 0) process.exit(1);

console.log(`dist/index.d.ts exports exactly the ${String(expected.length)} listed names`);
