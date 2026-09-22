import { expect, test } from "vitest";
import vectors from "../spec/vectors/policy.json" with { type: "json" };
import { resolve, thresholds, type Thresholds } from "../src/policy.js";
import { GuidemeError } from "../src/errors.js";
import { brandAnswer, type RawAnswer } from "./support/fixtures.js";

interface VectorThresholds {
  readonly yes_above: number;
  readonly no_below: number;
  readonly min_confidence: number;
}
interface Vector {
  readonly answer: RawAnswer;
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

// Two cases, which is what the budget allocates. The counts are asserted at collection time
// rather than in a third test, so the file cannot silently replay a vector file that has been
// truncated or re-vendored with a different shape, and a failure here fails the whole file.
expect(all, "spec/vectors/policy.json holds 42 vectors").toHaveLength(42);
expect(outcomes, "39 of them resolve to an outcome").toHaveLength(39);
expect(errors, "3 of them are protocol violations").toHaveLength(3);

test.each(outcomes)("vector $i resolves to its golden outcome", ({ v }) => {
  const got = resolve(brandAnswer(v.answer), settled(v.thresholds));
  expect(JSON.parse(JSON.stringify(got))).toEqual(v.outcome);
});

test.each(errors)("vector $i is a protocol violation", ({ v }) => {
  let thrown: unknown;
  try {
    resolve(brandAnswer(v.answer), settled(v.thresholds));
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(GuidemeError);
  expect(thrown).toMatchObject({ kind: "protocol" });
});
