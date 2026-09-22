import noul from "../fixtures/noul.json" with { type: "json" };
import type { Answer } from "../../src/policy.js";
import { confidence, probability } from "../../src/scalars.js";
import badNoul from "../fixtures/bad-noul.json" with { type: "json" };

/**
 * A docs fixture with its one answer re-keyed to `q0`, as JSON text.
 *
 * The docs fixtures key their answer by a name the caller chose (`is_urgent`), which is what
 * the wire allows; a `Guide` numbers its questions `q0..qN`, so a reply it can read has to use
 * that id. Derived here rather than kept as a second file, so the two cannot drift apart.
 */
const asQ0 = (fixture: { readonly answers: Readonly<Record<string, unknown>> }): string => {
  const answers = Object.values(fixture.answers);
  if (answers.length !== 1) throw new Error(`expected one answer, got ${String(answers.length)}`);
  return JSON.stringify({ ...fixture, answers: { q0: answers[0] } });
};

/** `fixtures/noul.json`, answered as `q0`: a yes at 0.95, 307 input tokens, 20 output. */
export const NOUL_AS_Q0: string = asQ0(noul);

/** `fixtures/bad-noul.json`, answered as `q0`: a noul probability of 1.5, out of range. */
export const BAD_NOUL_AS_Q0: string = asQ0(badNoul);

/** An answer as a JSON file spells it: every probability and confidence a plain number. */
export type RawAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly legend: Readonly<Record<string, string>>;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    };

/** Every probability of a distribution, through the one function that brands one. */
const brandAll = (
  ps: Readonly<Record<string, number>>,
): Record<string, ReturnType<typeof probability>> =>
  Object.fromEntries(Object.entries(ps).map(([k, p]) => [k, probability(p)]));

/**
 * Brand a raw answer the way `src/api/wire.ts` does, through `probability` and `confidence`,
 * so a test hands `resolve` exactly what the wire would and the vectors replay through the same
 * validation a response gets.
 */
export const brandAnswer = (raw: RawAnswer): Answer => {
  switch (raw.type) {
    case "noul":
      return { type: "noul", noul: probability(raw.noul) };
    case "choice":
      return {
        ...raw,
        probabilities: brandAll(raw.probabilities),
        confidence: confidence(raw.confidence),
      };
    case "score":
      return {
        ...raw,
        probabilities: brandAll(raw.probabilities),
        confidence: confidence(raw.confidence),
      };
  }
};
