import { expect, test } from "vitest";
import fc from "fast-check";
import { resolve, thresholds } from "../src/policy.js";
import type { ChoiceOutcome, NoulOutcome, Outcome, ScoreOutcome } from "../src/policy.js";
import { compareByCodePoint } from "../src/scalars.js";
import { option, render } from "../src/rubric.js";

const unit = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
const band = fc.tuple(unit, unit).map(([a, b]) => (a <= b ? ([a, b] as const) : ([b, a] as const)));

// `resolve` returns the union, and these narrow it rather than assert it down. A wrong arm is
// then a loud failure naming what came back, instead of a silent read of the wrong shape whose
// fields are all `undefined`.
const noulOutcome = (out: Outcome): NoulOutcome => {
  if (out.kind === "noul") return out;
  throw new Error(`expected a noul outcome, got ${out.kind}`);
};
const choiceOutcome = (out: Outcome): ChoiceOutcome => {
  if (out.kind === "choice") return out;
  throw new Error(`expected a choice outcome, got ${out.kind}`);
};
const scoreOutcome = (out: Outcome): ScoreOutcome => {
  if (out.kind === "score") return out;
  throw new Error(`expected a score outcome, got ${out.kind}`);
};

test("noul: yes above the top edge, no below the bottom, unsure strictly between", () => {
  fc.assert(
    fc.property(unit, band, (p, [noBelow, yesAbove]) => {
      const t = thresholds(yesAbove, noBelow, 0);
      const out = noulOutcome(resolve({ type: "noul", noul: p }, t));
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
      const l = noulOutcome(resolve({ type: "noul", noul: lo }, t));
      const h = noulOutcome(resolve({ type: "noul", noul: hi }, t));
      return order[l.verdict] <= order[h.verdict];
    }),
  );
  // Monotone in the thresholds: widening the band can only make more answers unsure.
  fc.assert(
    fc.property(unit, band, (p, [noBelow, yesAbove]) => {
      const narrow = thresholds(yesAbove, noBelow, 0);
      const wide = thresholds(Math.min(1, yesAbove + 0.1), Math.max(0, noBelow - 0.1), 0);
      const n = noulOutcome(resolve({ type: "noul", noul: p }, narrow));
      const w = noulOutcome(resolve({ type: "noul", noul: p }, wide));
      return n.verdict === "unsure" ? w.verdict === "unsure" : true;
    }),
  );
});

/** Descending by probability, and where two are equal, ascending by key. */
const isRanked = (ranked: ChoiceOutcome["ranked"]): boolean => {
  for (let i = 1; i < ranked.length; i += 1) {
    const prev = ranked[i - 1];
    const here = ranked[i];
    if (prev === undefined || here === undefined) return false;
    if (prev[1] < here[1]) return false;
    if (prev[1] === here[1] && compareByCodePoint(prev[0], here[0]) >= 0) return false;
  }
  return true;
};

test("choice: unsure iff confidence < minConfidence, and ranked is descending then by key", () => {
  // `unit: "grapheme"` on purpose. The default `fc.string()` in fast-check 4.10.2 draws from
  // printable ASCII only — measured, max code point U+007E over 2000 samples — so it can never
  // produce the pair the tie-break comparator exists for. This one reaches U+3134A.
  const distribution = fc.dictionary(
    fc.string({ unit: "grapheme", minLength: 1, maxLength: 8 }),
    unit,
    { minKeys: 1, maxKeys: 6 },
  );
  fc.assert(
    fc.property(distribution, unit, unit, (probabilities, c, minConfidence) => {
      const keys = Object.keys(probabilities);
      if (keys.length === 0) return true;
      const chosen = keys[0] ?? "";
      const t = thresholds(0.5, 0.5, minConfidence);
      const out = choiceOutcome(
        resolve({ type: "choice", choice: chosen, probabilities, confidence: c }, t),
      );
      if (out.unsure !== c < minConfidence) return false;
      if (out.ranked.length !== keys.length) return false;
      return isRanked(out.ranked);
    }),
  );

  // The one pair UTF-16 order gets wrong, asserted directly rather than left to the generator.
  // A supplementary code point is a surrogate pair starting at U+D83D, which `<` puts BEFORE
  // U+FFFF; by code point it comes after. Rust compares `char`s, so the SDKs would disagree.
  // Built from their code points rather than written as literals: on the literal types the
  // compiler folds the comparison and eslint reports the assertion as a constant condition,
  // and the numbers are what the claim is about anyway.
  const bmpMax = String.fromCodePoint(0xffff);
  const beyondBmp = String.fromCodePoint(0x1f600);
  expect(bmpMax < beyondBmp).toBe(false);
  expect(compareByCodePoint(bmpMax, beyondBmp)).toBeLessThan(0);

  // And through `resolve`, on a tie, where the comparator is the only thing deciding the order:
  // neither key is integer-like, so the object hands `Object.entries` the insertion order,
  // which is the opposite of the answer.
  const tied = choiceOutcome(
    resolve(
      {
        type: "choice",
        choice: bmpMax,
        probabilities: { [beyondBmp]: 0.5, [bmpMax]: 0.5 },
        confidence: 1,
      },
      thresholds(0.5, 0.5, 0),
    ),
  );
  expect(tied.ranked.map(([k]) => k)).toEqual([bmpMax, beyondBmp]);
});

test("score: index is the argmax, ties to the lowest", () => {
  fc.assert(
    fc.property(fc.array(unit, { minLength: 2, maxLength: 10 }), unit, (ps, c) => {
      const legend = Object.fromEntries(ps.map((_, i) => [String(i), `level ${String(i)}`]));
      const probabilities = Object.fromEntries(ps.map((p, i) => [String(i), p]));
      const out = scoreOutcome(
        resolve(
          { type: "score", score: 0, legend, probabilities, confidence: c },
          thresholds(0.5, 0.5, 0),
        ),
      );
      const best = Math.max(...ps);
      return out.index === ps.indexOf(best);
    }),
  );
});

test("a rubric with no parts renders to itself, byte for byte, for any string", () => {
  // `unit: "grapheme"`, not the default: `fc.string()` in fast-check 4.10.2 is printable ASCII
  // only (measured, max code point U+007E over 2000 samples), and "any string" has to include
  // the code points where a trim, a line-break test or a normalisation would change the bytes.
  fc.assert(fc.property(fc.string({ unit: "grapheme" }), (what) => render(option(what)) === what));
  // Including strings that are themselves blank, contain line breaks, or look like a clause,
  // and the five code points the three candidate blank-tests disagree about: U+0085 is
  // `White_Space` and `String.prototype.trim()` keeps it, U+FEFF is not and `trim()` removes
  // it, U+00A0 is one both agree on, and U+2028 / U+2029 are separators this package's
  // line-break primitive deliberately does not treat as line breaks.
  const written = ["", "   ", "\n", "a\nb", "Not this option: x", "a; b", " "];
  for (const what of [...written, "\u0085", "\u00a0", "\u2028", "\u2029", "\ufeff"]) {
    expect(render(option(what))).toBe(what);
  }
});
