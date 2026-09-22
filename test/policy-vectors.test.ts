import { expect, test } from "vitest";
import vectors from "../spec/vectors/policy.json" with { type: "json" };
import { resolve, thresholds, type Answer, type Thresholds } from "../src/policy.js";
import { GuidemeError } from "../src/errors.js";

interface VectorThresholds {
  readonly yes_above: number;
  readonly no_below: number;
  readonly min_confidence: number;
}
interface Vector {
  readonly answer: Answer;
  readonly thresholds: VectorThresholds;
  readonly outcome?: unknown;
  readonly error?: string;
}

// TypeScript types a JSON import structurally and widens every string to `string`, so
// `answer.type` arrives as `string` rather than the `"noul" | "choice" | "score"` the
// discriminated union needs. Measured: the direct annotation is `error TS2322`. One assertion
// declares the shape this suite replays; `spec/` is byte-identical to guideme-rust main, which
// the drift job proves, and the counts in the first row prove the file is the one claimed.
// The `as` rule is scoped to `src/**`, so this is inside it rather than an exception to it.
const all = vectors as readonly Vector[];
const settled = (t: VectorThresholds): Thresholds =>
  thresholds(t.yes_above, t.no_below, t.min_confidence);

const outcomes = all.map((v, i) => ({ v, i })).filter(({ v }) => v.outcome !== undefined);
const errors = all.map((v, i) => ({ v, i })).filter(({ v }) => v.error !== undefined);

// Two cases, which is what the budget allocates. The counts are asserted inside the first row
// of the first table rather than in a third test, so the file cannot silently replay a vector
// file that has been truncated or re-vendored with a different shape.
test.each(outcomes)("vector $i resolves to its golden outcome", ({ v, i }) => {
  if (i === 0) {
    expect(all).toHaveLength(42);
    expect(outcomes).toHaveLength(39);
    expect(errors).toHaveLength(3);
  }
  const got = resolve(v.answer, settled(v.thresholds));
  expect(JSON.parse(JSON.stringify(got))).toEqual(v.outcome);
});

test.each(errors)("vector $i is a protocol violation", ({ v }) => {
  let thrown: unknown;
  try {
    resolve(v.answer, settled(v.thresholds));
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(GuidemeError);
  expect(thrown).toMatchObject({ kind: "protocol" });
});
