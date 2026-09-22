import { expect, test } from "vitest";
import cases from "../spec/vectors/rubric.json" with { type: "json" };
import { level, option, render } from "../src/rubric.js";

interface RubricCase {
  readonly kind: "choice" | "levels" | "noul";
  readonly what: string;
  readonly examples: readonly string[];
  readonly counterexamples: readonly string[];
  readonly rendered: string;
}

// Same widening as the policy vectors: a JSON import types `kind` as `string`, so the shape
// this suite replays is declared once, here, in a test file.
const all = cases as readonly RubricCase[];

const rebuild = (c: RubricCase) => {
  const examples = c.examples.length > 0 ? { examples: c.examples } : {};
  const counterexamples =
    c.counterexamples.length > 0 ? { counterexamples: c.counterexamples } : {};
  return c.kind === "levels"
    ? level(c.what, { ...examples })
    : option(c.what, { ...examples, ...counterexamples });
};

// Asserted at collection time, so a truncated or re-vendored file fails the whole file.
expect(all, "spec/vectors/rubric.json holds 10 cases").toHaveLength(10);
expect(all.filter((x) => x.kind === "choice")).toHaveLength(6);
expect(all.filter((x) => x.kind === "levels")).toHaveLength(2);
expect(all.filter((x) => x.kind === "noul")).toHaveLength(2);

test.each(all.map((c, i) => ({ c, i })))("rubric vector $i renders byte for byte", ({ c }) => {
  expect(render(rebuild(c))).toBe(c.rendered);
});

test("an absent clause, an empty clause and no argument are three different things", () => {
  // No argument at all: renders to `what` itself, the load-bearing 0.1.0 guarantee.
  expect(render(option("Payments, invoicing, refunds"))).toBe("Payments, invoicing, refunds");
  expect(render(option("Payments, invoicing, refunds", {}))).toBe("Payments, invoicing, refunds");
  // A clause written out with nothing in it is refused: the caller described nothing.
  expect(() => option("Payments, invoicing, refunds", { examples: [] })).toThrow(
    expect.objectContaining({ kind: "config" }),
  );
  expect(() => option("Payments", { counterexamples: [] })).toThrow(
    expect.objectContaining({ kind: "config" }),
  );
  expect(() => level("Calm", { examples: [] })).toThrow(
    expect.objectContaining({ kind: "config" }),
  );
});
