// Every ```ts block in README.md must appear, line for line, in a test file the gate
// type-checks or runs. A README example that is not compiled somewhere drifts from the API the
// first time the API moves, and nothing says so.
//
// Two differences are allowed, both mechanical. Leading `import` statements are dropped: the
// README imports from "@guideme/sdk", a test from "../src/index.js". And each line is compared
// with its indentation trimmed, so a block can sit inside a test body.
import { readFileSync } from "node:fs";

const TARGETS = ["test/typing.test-d.ts", "test/wire.test.ts", "test/rubric-rules.test.ts"];

const trimmedLines = (text) => text.split("\n").map((line) => line.trim());

/** The README's ```ts blocks, each with the line its fence opens on. */
const blocks = [];
const readme = readFileSync("README.md", "utf8").split("\n");
for (let i = 0; i < readme.length; i += 1) {
  if (readme[i] !== "```ts") continue;
  const start = i + 1;
  let end = start;
  while (end < readme.length && readme[end] !== "```") end += 1;
  if (end === readme.length) {
    console.error(`README.md:${String(i + 1)}: a \`\`\`ts fence is never closed`);
    process.exit(1);
  }
  blocks.push({ line: i + 1, body: readme.slice(start, end) });
  i = end;
}
if (blocks.length === 0) {
  console.error("README.md has no ```ts block; the check would pass on nothing");
  process.exit(1);
}

/**
 * The block as comparable text: import statements removed, each line trimmed, leading blank
 * lines dropped, lines joined with "\n".
 */
const comparable = (body) => {
  const lines = trimmedLines(body.join("\n").replace(/^import\b[^;]*;$/gmu, ""));
  return lines.slice(lines.findIndex((line) => line !== "")).join("\n");
};

const targets = TARGETS.map((path) => ({
  path,
  text: `\n${trimmedLines(readFileSync(path, "utf8")).join("\n")}\n`,
}));

/** The 1-based line in `text` where `needle` starts as whole lines, or 0. */
const find = (text, needle) => {
  const at = text.indexOf(`\n${needle}\n`);
  return at === -1 ? 0 : text.slice(0, at + 1).split("\n").length - 1;
};

let failed = 0;
for (const block of blocks) {
  const needle = comparable(block.body);
  const hit = targets
    .map((t) => ({ path: t.path, at: find(t.text, needle) }))
    .find((h) => h.at > 0);
  if (hit === undefined) {
    failed += 1;
    console.error(
      `README.md:${String(block.line)}: this block appears in none of ${TARGETS.join(", ")}`,
    );
  } else {
    console.log(`README.md:${String(block.line)}: ${hit.path}:${String(hit.at)}`);
  }
}
if (failed > 0) process.exit(1);
console.log(`all ${String(blocks.length)} README examples are compiled by a test`);
