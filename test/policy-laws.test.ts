import { test } from "vitest";
import fc from "fast-check";
import { resolve, thresholds } from "../src/policy.js";
import type { ChoiceOutcome, NoulOutcome, ScoreOutcome } from "../src/policy.js";
import { compareByCodePoint } from "../src/scalars.js";

const unit = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
const band = fc.tuple(unit, unit).map(([a, b]) => (a <= b ? ([a, b] as const) : ([b, a] as const)));

test("noul: yes above the top edge, no below the bottom, unsure strictly between", () => {
  fc.assert(
    fc.property(unit, band, (p, [noBelow, yesAbove]) => {
      const t = thresholds(yesAbove, noBelow, 0);
      const out = resolve({ type: "noul", noul: p }, t) as NoulOutcome;
      if (p >= yesAbove) return out.verdict === "yes";
      if (p <= noBelow) return out.verdict === "no";
      return out.verdict === "unsure" && p > noBelow && p < yesAbove;
    }),
  );
  // Monotone in p: raising p can only move the verdict toward yes.
  const order = { no: 0, unsure: 1, yes: 2 } as const;
  fc.assert(
    fc.property(unit, unit, band, (a, b, [noBelow, yesAbove]) => {
      const t = thresholds(yesAbove, noBelow, 0);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const l = resolve({ type: "noul", noul: lo }, t) as NoulOutcome;
      const h = resolve({ type: "noul", noul: hi }, t) as NoulOutcome;
      return order[l.verdict] <= order[h.verdict];
    }),
  );
  // Monotone in the thresholds: widening the band can only make more answers unsure.
  fc.assert(
    fc.property(unit, band, (p, [noBelow, yesAbove]) => {
      const narrow = thresholds(yesAbove, noBelow, 0);
      const wide = thresholds(Math.min(1, yesAbove + 0.1), Math.max(0, noBelow - 0.1), 0);
      const n = resolve({ type: "noul", noul: p }, narrow) as NoulOutcome;
      const w = resolve({ type: "noul", noul: p }, wide) as NoulOutcome;
      return n.verdict === "unsure" ? w.verdict === "unsure" : true;
    }),
  );
});

test("choice: unsure iff confidence < minConfidence, and ranked is descending then by key", () => {
  const distribution = fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), unit, {
    minKeys: 1,
    maxKeys: 6,
  });
  fc.assert(
    fc.property(distribution, unit, unit, (probabilities, c, minConfidence) => {
      const keys = Object.keys(probabilities);
      if (keys.length === 0) return true;
      const chosen = keys[0] ?? "";
      const t = thresholds(0.5, 0.5, minConfidence);
      const out = resolve(
        { type: "choice", choice: chosen, probabilities, confidence: c },
        t,
      ) as ChoiceOutcome;
      if (out.unsure !== c < minConfidence) return false;
      if (out.ranked.length !== keys.length) return false;
      for (let i = 1; i < out.ranked.length; i += 1) {
        const prev = out.ranked[i - 1];
        const here = out.ranked[i];
        if (prev === undefined || here === undefined) return false;
        if (prev[1] < here[1]) return false;
        if (prev[1] === here[1] && compareByCodePoint(prev[0], here[0]) >= 0) return false;
      }
      return true;
    }),
  );
});

test("score: index is the argmax, ties to the lowest", () => {
  fc.assert(
    fc.property(fc.array(unit, { minLength: 2, maxLength: 10 }), unit, (ps, c) => {
      const legend = Object.fromEntries(ps.map((_, i) => [String(i), `level ${String(i)}`]));
      const probabilities = Object.fromEntries(ps.map((p, i) => [String(i), p]));
      const out = resolve(
        { type: "score", score: 0, legend, probabilities, confidence: c },
        thresholds(0.5, 0.5, 0),
      ) as ScoreOutcome;
      const best = Math.max(...ps);
      return out.index === ps.indexOf(best);
    }),
  );
});
