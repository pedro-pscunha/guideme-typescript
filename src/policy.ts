import { configError, protocolError, assertNever } from "./errors.js";
import { compareByCodePoint, confidence, probability, MAX_LEVELS, MIN_LEVELS } from "./scalars.js";
import type { Confidence, Probability } from "./scalars.js";

/**
 * One answer, as `resolve` takes it. This module owns the type: the goal's type-model boundary
 * says `resolve` takes plain typed objects rather than anything the wire layer produced, and
 * `src/api/wire.ts` imports this and parses into it. The field names are the wire's because
 * the wire is where the values come from; nothing else about this type is the wire's.
 */
export type Answer =
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

/**
 * A policy patch. An unset field defers to the next layer: question over guide over the
 * defaults `{ yesAbove: 0.5, noBelow: 0.5, minConfidence: 0.0 }`.
 */
export interface Policy {
  /** Noul: `p >= yesAbove` is yes. */
  readonly yesAbove?: number | undefined;
  /** Noul: `p <= noBelow` is no. */
  readonly noBelow?: number | undefined;
  /** Choice and score: `confidence < minConfidence` is unsure. */
  readonly minConfidence?: number | undefined;
}

/** Fully settled, validated thresholds: the input of {@link resolve} and of every vector. */
export interface Thresholds {
  /** Noul yes boundary, inclusive. */
  readonly yesAbove: number;
  /** Noul no boundary, inclusive. Never greater than `yesAbove`. */
  readonly noBelow: number;
  /** Choice and score confidence floor. */
  readonly minConfidence: number;
}

/** The defaults: no unsure band on a noul, never unsure on confidence. */
export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  yesAbove: 0.5,
  noBelow: 0.5,
  minConfidence: 0,
});

/** Validate: every field in `0..=1`, and `noBelow <= yesAbove`. */
export const thresholds = (
  yesAbove: number,
  noBelow: number,
  minConfidence: number,
): Thresholds => {
  for (const [name, v] of [
    ["yes_above", yesAbove],
    ["no_below", noBelow],
    ["min_confidence", minConfidence],
  ] as const) {
    if (!(v >= 0 && v <= 1)) throw configError(`${name} = ${String(v)} is outside 0..=1`);
  }
  if (noBelow > yesAbove) {
    throw configError(`no_below ${String(noBelow)} > yes_above ${String(yesAbove)}`);
  }
  return Object.freeze({ yesAbove, noBelow, minConfidence });
};

/** `patch` wins over `base`, field by field. */
export const over = (patch: Policy, base: Policy): Policy => ({
  yesAbove: patch.yesAbove ?? base.yesAbove,
  noBelow: patch.noBelow ?? base.noBelow,
  minConfidence: patch.minConfidence ?? base.minConfidence,
});

/** Fill unset fields with the defaults and validate. */
export const settle = (policy: Policy): Thresholds =>
  thresholds(
    policy.yesAbove ?? DEFAULT_THRESHOLDS.yesAbove,
    policy.noBelow ?? DEFAULT_THRESHOLDS.noBelow,
    policy.minConfidence ?? DEFAULT_THRESHOLDS.minConfidence,
  );

/** The three-way reading of a noul answer. */
export interface Verdict {
  /** `yes` when `p >= yesAbove`, `no` when `p <= noBelow`, otherwise `unsure`. */
  readonly verdict: "yes" | "no" | "unsure";
  /** The probability that was judged. */
  readonly p: Probability;
}

/** What the policy concludes about a noul answer. */
export interface NoulOutcome extends Verdict {
  /** Discriminant. */
  readonly kind: "noul";
}

/** What the policy concludes about a choice answer. Untyped: keys, not a caller's union. */
export interface ChoiceOutcome {
  /** Discriminant. */
  readonly kind: "choice";
  /** The API's chosen key. */
  readonly key: string;
  /** Reported confidence. */
  readonly confidence: Confidence;
  /** `confidence \< minConfidence`. */
  readonly unsure: boolean;
  /** Options by descending probability, ties by key. */
  readonly ranked: readonly (readonly [string, Probability])[];
}

/** What the policy concludes about a score answer. Levels are positional. */
export interface ScoreOutcome {
  /** Discriminant. */
  readonly kind: "score";
  /** Argmax of the distribution; ties go to the lowest index. */
  readonly index: number;
  /** The API's expected value; may land between levels. */
  readonly value: number;
  /** Reported confidence. */
  readonly confidence: Confidence;
  /** `confidence \< minConfidence`. */
  readonly unsure: boolean;
  /** Probability of each level, in level order. */
  readonly distribution: readonly Probability[];
  /** Description of each level, in level order. */
  readonly legend: readonly string[];
}

/** The policy's reading of one answer. */
export type Outcome = NoulOutcome | ChoiceOutcome | ScoreOutcome;

/** The level keys `"0".."n-1"`, sorted numerically, or `undefined` when they are not contiguous. */
const contiguousKeys = (
  map: Readonly<Record<string, unknown>>,
  n: number,
): readonly string[] | undefined => {
  const keys = Object.keys(map);
  if (keys.length !== n) return undefined;
  const wanted = Array.from({ length: n }, (_, i) => String(i));
  const sorted = [...keys].sort((a, b) => Number(a) - Number(b));
  return sorted.every((k, i) => k === wanted[i]) ? wanted : undefined;
};

/**
 * Read one level out of a map the contiguity check has already proved complete.
 *
 * No `?? 0` and no `?? ""`: the check proved every key `0..n-1` is present in both maps, so a
 * miss here is that proof being wrong, which is a protocol violation and not a value to
 * substitute. Substituting would turn a malformed response into a confident answer.
 */
const at = <T>(map: Readonly<Record<string, T>>, k: string, what: string): T => {
  const v = map[k];
  if (v === undefined) {
    throw protocolError(`score ${what} is missing level ${k} after passing the shape check`);
  }
  return v;
};

/** The noul arm of {@link resolve}. */
const resolveNoul = (answer: Extract<Answer, { type: "noul" }>, t: Thresholds): NoulOutcome => {
  const p = probability(answer.noul);
  const verdict = p >= t.yesAbove ? "yes" : p <= t.noBelow ? "no" : "unsure";
  return Object.freeze({ kind: "noul", verdict, p });
};

/** The choice arm of {@link resolve}. */
const resolveChoice = (
  answer: Extract<Answer, { type: "choice" }>,
  t: Thresholds,
): ChoiceOutcome => {
  const probabilities = answer.probabilities;
  if (!Object.hasOwn(probabilities, answer.choice)) {
    throw protocolError(`choice "${answer.choice}" is not in the distribution`);
  }
  // guideme/src/policy.rs: sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0))).
  // Descending probability, then ascending key. Never rely on object key order: a JS
  // object preserves insertion order for non-integer keys while Rust's BTreeMap sorts.
  const ranked = Object.entries(probabilities)
    .map(([k, p]) => [k, probability(p)] as const)
    .sort((a, b) => (b[1] === a[1] ? compareByCodePoint(a[0], b[0]) : b[1] - a[1]));
  const c = confidence(answer.confidence);
  return Object.freeze({
    kind: "choice",
    key: answer.choice,
    confidence: c,
    unsure: c < t.minConfidence,
    ranked: Object.freeze(ranked),
  });
};

/** The argmax of a distribution; a tie goes to the lowest index. */
const argmax = (distribution: readonly Probability[]): number => {
  // guideme/src/policy.rs folds over the keys in ascending order and replaces the best
  // only on a STRICTLY greater probability, so a tie goes to the lowest index.
  let index = 0;
  let best = distribution[0];
  if (best === undefined) throw protocolError("score distribution is empty");
  for (let i = 1; i < distribution.length; i += 1) {
    const p = distribution[i];
    // Strictly greater, so a tie goes to the lowest index, as guideme/src/policy.rs does.
    if (p !== undefined && p > best) {
      best = p;
      index = i;
    }
  }
  return index;
};

/** The score arm of {@link resolve}. */
const resolveScore = (answer: Extract<Answer, { type: "score" }>, t: Thresholds): ScoreOutcome => {
  const n = Object.keys(answer.legend).length;
  const legendKeys = contiguousKeys(answer.legend, n);
  const probKeys = contiguousKeys(answer.probabilities, n);
  if (n < MIN_LEVELS || n > MAX_LEVELS || legendKeys === undefined || probKeys === undefined) {
    throw protocolError(
      `score legend/probabilities must be contiguous levels 0..n with ${String(MIN_LEVELS)} <= n <= ${String(MAX_LEVELS)}, got ${String(n)}`,
    );
  }
  const max = n - 1;
  if (!(answer.score >= 0 && answer.score <= max)) {
    throw protocolError(`score ${String(answer.score)} is outside 0..=${String(max)}`);
  }
  const distribution = legendKeys.map((k) =>
    probability(at(answer.probabilities, k, "probabilities")),
  );
  const legend = legendKeys.map((k) => at(answer.legend, k, "legend"));
  const c = confidence(answer.confidence);
  return Object.freeze({
    kind: "score",
    index: argmax(distribution),
    value: answer.score,
    confidence: c,
    unsure: c < t.minConfidence,
    distribution: Object.freeze(distribution),
    legend: Object.freeze(legend),
  });
};

/**
 * Apply thresholds to one answer. Pure and total except for a malformed answer.
 *
 * Throws a `protocol` `GuidemeError` when the chosen key is absent from the
 * distribution, when the legend and distribution are not the same contiguous `0..n` with
 * `2 \<= n \<= 10`, or when the score lies outside the level range.
 */
export const resolve = (answer: Answer, t: Thresholds): Outcome => {
  switch (answer.type) {
    case "noul":
      return resolveNoul(answer, t);
    case "choice":
      return resolveChoice(answer, t);
    case "score":
      return resolveScore(answer, t);
    default:
      return assertNever(answer);
  }
};
