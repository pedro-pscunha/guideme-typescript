import { assertNever, configError, protocolError, unsureError } from "./errors.js";
import type { GuidemeError } from "./errors.js";
import { over, settle } from "./policy.js";
import type { Outcome, Policy, Thresholds, Verdict } from "./policy.js";
import { asLevelRubric, option, renderLevels, renderOptions, renderPair } from "./rubric.js";
import type { LevelRubric, OptionRubric } from "./rubric.js";
import {
  MAX_LEVELS,
  MAX_OPTIONS,
  MIN_LEVELS,
  key as brandKey,
  rank as brandRank,
} from "./scalars.js";
import type { Confidence, Key, Probability, Rank } from "./scalars.js";
import type { WireNoulCriteria, WireQuestion } from "./api/wire.js";

/** True only when `T` is a union of two or more members. */
type IsUnion<T, U = T> = T extends U ? ([U] extends [T] ? false : true) : never;

/**
 * `S` when its key union has at least two members, otherwise `never`, so that
 * `S & AtLeastTwoKeys<S>` is `never` and the call does not type-check. All three cases are
 * spelled out: an empty object has no keys, one key is not a union, two or more is.
 */
type AtLeastTwoKeys<S> = [Extract<keyof S, string>] extends [never]
  ? never
  : IsUnion<Extract<keyof S, string>> extends true
    ? S
    : never;

/**
 * An own enumerable key of `spec`. The body is the check that justifies the narrowing:
 * `Object.keys` is typed `string[]` because a JavaScript object may carry keys its type does
 * not mention, and `Object.hasOwn` is what proves a given one is `keyof S`.
 */
const isOwnKey = <S extends object>(spec: S, k: string): k is Extract<keyof S, string> =>
  Object.hasOwn(spec, k);

/** `Object.keys`, with the key type the declaration already carries, in declaration order. */
const keysOf = <S extends object>(spec: S): Extract<keyof S, string>[] =>
  Object.keys(spec).filter((k) => isOwnKey(spec, k));

/** What a question is asked about: text, or a structured object holding it. */
type Instructions = string | Readonly<Record<string, unknown>>;

/** An ordered set of options, declared once and reused. Built by {@link choice}. */
interface ChoiceDescriptor<K extends string> {
  /** Discriminant. */
  readonly descriptor: "choice";
  /** The option keys, in declaration order. */
  readonly keys: readonly K[];
  /** Each option's rubric, in the same order as {@link ChoiceDescriptor.keys}. */
  readonly rubrics: readonly OptionRubric[];
  /** The key marked with `fallback`, if any. */
  readonly fallbackKey: K | undefined;
}

/** The option type of a descriptor: the literal union of its keys. */
export type Option<D> = D extends ChoiceDescriptor<infer K> ? K : never;

/**
 * Each key with its rubric, walked together. The two arrays are built side by side, so a
 * length mismatch means a descriptor was assembled by hand — by JavaScript, since the type
 * cannot express one — and it is refused rather than padded: a missing rubric is not `null`,
 * which means "an option described not at all", and filling one in would invent a declaration.
 */
const paired = <K extends string>(
  keys: readonly K[],
  rubrics: readonly (OptionRubric | null)[],
): (readonly [K, OptionRubric | null])[] => {
  const pairs = keys.flatMap((k, i) => {
    const r = rubrics[i];
    return r === undefined ? [] : [[k, r] as const];
  });
  if (pairs.length !== keys.length || rubrics.length !== keys.length) {
    throw configError(
      `a choice has ${String(keys.length)} keys but ${String(rubrics.length)} rubrics`,
    );
  }
  return pairs;
};

/**
 * Check a whole set of options and name the one marked as the fallback.
 *
 * Shared by {@link choice} and {@link chooseAmong} rather than written twice: both hold the
 * whole set at once, so both enforce the same rules, and two copies would be two rules waiting
 * to diverge. Rules 1-5, 8, 9, 11 and 12 all fire here, where the options were written.
 */
const checkedOptions = <K extends string>(
  keys: readonly K[],
  rubrics: readonly (OptionRubric | null)[],
  where: "declared" | "runtime",
): K | undefined => {
  const marked = keys.filter((_, i) => rubrics[i]?.isFallback === true);
  // A runtime choice answers a `Key` and has two rungs, not three: `.or(key)`, then the typed
  // `unsure` error. Rust says the same by not naming a fallback variant in `impl Options for
  // Key`. Refused rather than ignored, because a `fallback()` that silently did nothing would
  // be a rung the caller believes they have.
  if (where === "runtime" && marked.length > 0) {
    throw configError(
      `runtime options carry no fallback; ${marked.map((m) => JSON.stringify(m)).join(", ")} ${marked.length === 1 ? "is" : "are"} marked with fallback(). Use .or(key) for the unsure rung`,
    );
  }
  if (marked.length > 1) {
    throw configError(
      `a choice may have at most one fallback; ${marked.map((m) => JSON.stringify(m)).join(", ")} are all marked`,
    );
  }
  renderOptions(paired(keys, rubrics));
  return marked[0];
};

/**
 * Declare a set of options. At least two are required, exactly one may be a `fallback`, and
 * declaration order is the order the options reach the wire.
 */
export const choice = <const S extends Readonly<Record<string, OptionRubric>>>(
  spec: S & AtLeastTwoKeys<S>,
): ChoiceDescriptor<Extract<keyof S, string>> => {
  const keys = keysOf(spec);
  const rubrics = keys.map((k) => spec[k]);
  // Rule 5 runs here so a shared example fails where the set was declared.
  const fallbackKey = checkedOptions(keys, rubrics, "declared");
  return Object.freeze({
    descriptor: "choice",
    keys: Object.freeze(keys),
    rubrics: Object.freeze(rubrics),
    fallbackKey,
  });
};

/** An ordered scale, declared once. Declaration order is level order, low to high. */
interface LevelsDescriptor<K extends string> {
  /** Discriminant. */
  readonly descriptor: "levels";
  /** The level keys, low to high. */
  readonly keys: readonly K[];
  /** Each level's rubric, in the same order as {@link LevelsDescriptor.keys}. */
  readonly rubrics: readonly LevelRubric[];
  /** This level's position, `0` for the lowest. */
  index(level: K): number;
  /** Negative, zero or positive, like a comparator. */
  compare(a: K, b: K): number;
  /** `a` is at or above `b` on this scale. Never use `\>=` on the strings: that is lexical. */
  atLeast(a: K, b: K): boolean;
  /** This level's position as a {@link Rank}. */
  rank(level: K): Rank;
}

/** The level type of a descriptor: the literal union of its keys. */
export type Level<D> = D extends LevelsDescriptor<infer K> ? K : never;

/**
 * Declare an ordered scale, low to high. At least two levels are required. A bare string is a
 * rubric with no parts; `level` adds examples. A level takes no counterexamples, and an
 * {@link OptionRubric} in this position is a type error.
 */
export const levels = <const S extends Readonly<Record<string, string | LevelRubric>>>(
  spec: S & AtLeastTwoKeys<S>,
): LevelsDescriptor<Extract<keyof S, string>> => {
  const keys = keysOf(spec);
  const rubrics = keys.map((k) => asLevelRubric(spec[k]));
  // Rules 6 and 10 run here so a shared example or a stray counterexample fails at declaration.
  renderLevels(rubrics);
  const indexOf = (l: Extract<keyof S, string>): number => {
    const i = keys.indexOf(l);
    if (i < 0) throw configError(`${JSON.stringify(l)} is not a level of this scale`);
    return i;
  };
  // Annotated rather than inlined into `Object.freeze`, which infers its argument's type and
  // so would leave the three comparators' parameters implicitly `any`.
  const descriptor: LevelsDescriptor<Extract<keyof S, string>> = {
    descriptor: "levels",
    keys: Object.freeze(keys),
    rubrics: Object.freeze(rubrics),
    index: indexOf,
    compare: (a, b) => indexOf(a) - indexOf(b),
    atLeast: (a, b) => indexOf(a) >= indexOf(b),
    rank: (l) => brandRank(indexOf(l)),
  };
  return Object.freeze(descriptor);
};

/** A yes/no question. The plain output is `boolean`; `.detail()` switches to {@link Verdict}. */
export interface NoulQuestion<Out = boolean> {
  /** Discriminant. */
  readonly kind: "noul";
  /** Merge a policy patch over this question's. */
  with(policy: Policy): NoulQuestion<Out>;
  /** `p \>= yesAbove` is yes. */
  yesAbove(p: number): NoulQuestion<Out>;
  /** `p \<= noBelow` is no. */
  noBelow(p: number): NoulQuestion<Out>;
  /** Value to use when the policy says unsure. */
  or(value: Out): NoulQuestion<Out>;
  /** Describe what a yes and a no mean. A description, or a rubric carrying examples. */
  criteria(yes: string | OptionRubric, no: string | OptionRubric): NoulQuestion<Out>;
  /** Ask for the full reading. Never fails on unsure; drops any `.or(..)` set before it. */
  detail(): DetailedNoulQuestion;
}

/** A choice over `K`. The plain output is `K`; `.detail()` switches to {@link Ranked}. */
export interface ChoiceQuestion<K extends string, Out = K> {
  /** Discriminant. */
  readonly kind: "choice";
  /** Merge a policy patch over this question's. */
  with(policy: Policy): ChoiceQuestion<K, Out>;
  /** `confidence \< minConfidence` is unsure. */
  minConfidence(c: number): ChoiceQuestion<K, Out>;
  /** Value to use when the policy says unsure. Beats the descriptor's fallback. */
  or(value: Out): ChoiceQuestion<K, Out>;
  /** Ask for the full reading. Never fails on unsure. */
  detail(): DetailedChoiceQuestion<Ranked<K>>;
}

/** A score over `K`. The plain output is the argmax `K`; `.detail()` gives {@link Scored}. */
export interface ScoreQuestion<K extends string, Out = K> {
  /** Discriminant. */
  readonly kind: "score";
  /** Merge a policy patch over this question's. */
  with(policy: Policy): ScoreQuestion<K, Out>;
  /** `confidence \< minConfidence` is unsure. */
  minConfidence(c: number): ScoreQuestion<K, Out>;
  /** Value to use when the policy says unsure. */
  or(value: Out): ScoreQuestion<K, Out>;
  /** Ask for the full reading. Never fails on unsure. */
  detail(): DetailedScoreQuestion<Scored<K>>;
}

// A question asked for its full reading has NO `or`, and that is the whole point of these
// three interfaces. `readAnswer` dispatches on `detailed` before it looks at a fallback, so a
// value set after `.detail()` would be silently discarded; Rust says the same thing by not
// implementing `Fallible` for `Detailed<K>`. They are exported for `src/ask.ts`, which needs
// them in `Shape` and `Answered`, and are NOT re-exported from `src/index.ts`: a caller meets
// one only as the return type of `detail()`, which is why the public surface stays at thirteen
// values and twenty-three types.
//
// The choice and score ones are parameterised by the ANSWER rather than by the key, because
// that is the type argument `Answered` reads straight back off the reference.

/** A noul asked for its full reading. Answers {@link Verdict}. */
export interface DetailedNoulQuestion {
  /** Discriminant. */
  readonly kind: "noul";
  /** Merge a policy patch over this question's. */
  with(policy: Policy): DetailedNoulQuestion;
  /** `p \>= yesAbove` is yes. */
  yesAbove(p: number): DetailedNoulQuestion;
  /** `p \<= noBelow` is no. */
  noBelow(p: number): DetailedNoulQuestion;
  /** Describe what a yes and a no mean. A description, or a rubric carrying examples. */
  criteria(yes: string | OptionRubric, no: string | OptionRubric): DetailedNoulQuestion;
}

/** A choice asked for its full reading. Answers {@link Ranked}. */
export interface DetailedChoiceQuestion<Out> {
  /** Discriminant. */
  readonly kind: "choice";
  /** Merge a policy patch over this question's. */
  with(policy: Policy): DetailedChoiceQuestion<Out>;
  /** `confidence \< minConfidence` is unsure. */
  minConfidence(c: number): DetailedChoiceQuestion<Out>;
}

/** A score asked for its full reading. Answers {@link Scored}. */
export interface DetailedScoreQuestion<Out> {
  /** Discriminant. */
  readonly kind: "score";
  /** Merge a policy patch over this question's. */
  with(policy: Policy): DetailedScoreQuestion<Out>;
  /** `confidence \< minConfidence` is unsure. */
  minConfidence(c: number): DetailedScoreQuestion<Out>;
}

/** Any question, for the shape mapper. */
export type Question<Out = unknown> =
  NoulQuestion<Out> | ChoiceQuestion<string, Out> | ScoreQuestion<string, Out>;

/**
 * Any question value the shape mapper may meet, for the two internal entry points.
 *
 * The three detailed shapes are members because `src/ask.ts` narrows a `Shape` with a
 * predicate over this type: a member it left out would survive into the object branch, where
 * `Object.entries` over an interface with no index signature widens to `any`. `encodeQuestion`
 * and `readAnswer` re-check with `instanceof` before they trust any of them.
 */
export type AnyQuestion =
  | Question
  | DetailedNoulQuestion
  | DetailedChoiceQuestion<unknown>
  | DetailedScoreQuestion<unknown>;

/** A choice answer in full: the pick, its confidence, and the whole distribution. */
export interface Ranked<K extends string> {
  /** The chosen option. */
  readonly choice: K;
  /** Reported confidence. */
  readonly confidence: Confidence;
  /** `confidence \< minConfidence`. */
  readonly unsure: boolean;
  /** Options by descending probability, ties by key. */
  readonly probabilities: readonly (readonly [K, Probability])[];
}

/** A score answer in full: expected value, argmax level, confidence, distribution. */
export interface Scored<K extends string> {
  /** The API's probability-weighted value; may lie between levels. */
  readonly value: number;
  /** Argmax of the distribution. */
  readonly level: K;
  /** Reported confidence. */
  readonly confidence: Confidence;
  /** `confidence \< minConfidence`. */
  readonly unsure: boolean;
  /** Probabilities in level order. */
  readonly distribution: readonly (readonly [K, Probability])[];
}

/** A question's wire body and the thresholds it settled to. */
interface Encoded {
  /** The body that goes under this question's id. */
  readonly wire: WireQuestion;
  /** This question's settled thresholds, after the guide's policy and the defaults. */
  readonly thresholds: Thresholds;
}

/** A fallback that was set. Wrapped, so `.or(false)` and "no fallback" are different things. */
interface Fallback<Out> {
  readonly value: Out;
}

/** The protocol error for an answer whose kind is not the one the question asked. */
const mismatch = (id: string, want: string, got: string): GuidemeError =>
  protocolError(`question ${id} asked for ${want}, answer is ${got}`);

/** A bare string is a rubric with no parts, in an option position. */
const asOptionRubric = (v: string | OptionRubric): OptionRubric =>
  typeof v === "string" ? option(v) : v;

/**
 * Everything a noul question carries. The implementation classes are immutable: every method
 * returns a new instance built from a copy of this record, so the state is one object rather
 * than eight positional arguments repeated at every call site.
 */
interface NoulState<Out> {
  readonly instructions: Instructions;
  readonly criteria: readonly [OptionRubric, OptionRubric] | undefined;
  readonly policy: Policy;
  readonly or: Fallback<Out> | undefined;
  readonly detailed: boolean;
}

class NoulImpl<Out> {
  readonly kind = "noul" as const;
  readonly #s: NoulState<Out>;

  constructor(s: NoulState<Out>) {
    this.#s = s;
    Object.freeze(this);
  }

  with(policy: Policy): NoulQuestion<Out> {
    return new NoulImpl({ ...this.#s, policy: over(policy, this.#s.policy) });
  }
  yesAbove(p: number): NoulQuestion<Out> {
    return this.with({ yesAbove: p });
  }
  noBelow(p: number): NoulQuestion<Out> {
    return this.with({ noBelow: p });
  }
  or(value: Out): NoulQuestion<Out> {
    return new NoulImpl({ ...this.#s, or: { value } });
  }
  criteria(yes: string | OptionRubric, no: string | OptionRubric): NoulQuestion<Out> {
    const pair = [asOptionRubric(yes), asOptionRubric(no)] as const;
    // Rule 7 fires here, where the pair was written, not later at ask time.
    renderPair(pair[0], pair[1]);
    return new NoulImpl({ ...this.#s, criteria: pair });
  }
  detail(): DetailedNoulQuestion {
    // A detailed reading never consults a fallback, so any `.or(..)` set before this is
    // dropped rather than carried forward, exactly as Rust's `Detailed<K>` drops it.
    return new NoulImpl<Verdict>({ ...this.#s, or: undefined, detailed: true });
  }

  encode(base: Policy): Encoded {
    const written = this.#s.criteria;
    const criteria =
      written === undefined
        ? undefined
        : ((): WireNoulCriteria => {
            const [yes, no] = renderPair(written[0], written[1]);
            return { true: yes, false: no };
          })();
    return {
      wire: { type: "noul", instructions: this.#s.instructions, criteria },
      thresholds: settle(over(this.#s.policy, base)),
    };
  }

  // The reading is split in two rather than written as one `read(): Out`. `Out` is `boolean`
  // on a plain noul and `Verdict` on a detailed one, and a single method could not produce
  // either without `as unknown as Out`, which the lint rule forbids and which would be the
  // only unchecked step in the package. Two methods, each returning its own concrete type,
  // need no cast at all; `readAnswer` picks between them.

  #readVerdict(id: string, outcome: Outcome): Verdict {
    if (outcome.kind !== "noul") throw mismatch(id, "noul", outcome.kind);
    return { verdict: outcome.verdict, p: outcome.p };
  }

  /** The detailed reading. Never fails on unsure. */
  readDetail(id: string, outcome: Outcome): Verdict {
    return this.#readVerdict(id, outcome);
  }

  /** The plain reading, which may walk the unsure ladder. */
  readPlain(
    id: string,
    outcome: Outcome,
    t: Thresholds,
    or: Fallback<Out> | undefined,
  ): boolean | Out {
    const v = this.#readVerdict(id, outcome);
    if (v.verdict === "yes") return true;
    if (v.verdict === "no") return false;
    if (or !== undefined) return or.value;
    const p: number = v.p;
    const nearer = t.yesAbove - p <= p - t.noBelow ? t.yesAbove : t.noBelow;
    throw unsureError(id, p, nearer);
  }

  /** Whether `.detail()` was called. */
  get detailed(): boolean {
    return this.#s.detailed;
  }

  /** The fallback, if one was set. Wrapped, so `.or(false)` is not "no fallback". */
  get fallback(): Fallback<Out> | undefined {
    return this.#s.or;
  }
}

/** Everything a choice question carries. See {@link NoulState} for why this is one record. */
interface ChoiceState<K extends string, Out> {
  readonly instructions: Instructions;
  readonly keys: readonly K[];
  readonly rubrics: readonly (OptionRubric | null)[];
  readonly fallbackKey: K | undefined;
  readonly policy: Policy;
  readonly or: Fallback<Out> | undefined;
  readonly detailed: boolean;
  /**
   * Built from runtime options rather than from a descriptor, so the plain answer is a
   * branded {@link Key} — what {@link chooseAmong} declares — instead of the key union a
   * {@link choice} descriptor carries.
   */
  readonly runtime: boolean;
}

class ChoiceImpl<K extends string, Out> {
  readonly kind = "choice" as const;
  readonly #s: ChoiceState<K, Out>;

  constructor(s: ChoiceState<K, Out>) {
    this.#s = s;
    Object.freeze(this);
  }

  with(policy: Policy): ChoiceQuestion<K, Out> {
    return new ChoiceImpl({ ...this.#s, policy: over(policy, this.#s.policy) });
  }
  minConfidence(c: number): ChoiceQuestion<K, Out> {
    return this.with({ minConfidence: c });
  }
  or(value: Out): ChoiceQuestion<K, Out> {
    return new ChoiceImpl({ ...this.#s, or: { value } });
  }
  detail(): DetailedChoiceQuestion<Ranked<K>> {
    return new ChoiceImpl<K, Ranked<K>>({ ...this.#s, or: undefined, detailed: true });
  }

  encode(base: Policy): Encoded {
    const keys = this.#s.keys;
    if (keys.length === 0) throw configError("a choice needs at least one option");
    if (keys.length > MAX_OPTIONS) {
      throw configError(`a choice may have at most ${String(MAX_OPTIONS)} options`);
    }
    const rendered = renderOptions(paired(keys, this.#s.rubrics));
    const criteria: Record<string, string | null> = {};
    for (const [name, text] of rendered) criteria[name] = text;
    if (Object.keys(criteria).length !== keys.length) {
      throw configError("duplicate option keys");
    }
    return {
      wire: { type: "choice", instructions: this.#s.instructions, criteria },
      thresholds: settle(over(this.#s.policy, base)),
    };
  }

  #readRanked(id: string, outcome: Outcome): Ranked<K> {
    if (outcome.kind !== "choice") throw mismatch(id, "choice", outcome.kind);
    const keys = this.#s.keys;
    if (outcome.ranked.length !== keys.length) {
      throw protocolError(
        `question ${id}: answer has ${String(outcome.ranked.length)} options, rubric has ${String(keys.length)}`,
      );
    }
    const known = (k: string): K => {
      const found = keys.find((candidate) => candidate === k);
      if (found === undefined) {
        throw protocolError(`question ${id}: option ${JSON.stringify(k)} is not in the rubric`);
      }
      return found;
    };
    return {
      choice: known(outcome.key),
      confidence: outcome.confidence,
      unsure: outcome.unsure,
      probabilities: outcome.ranked.map(([k, p]) => [known(k), p] as const),
    };
  }

  /** The key as this question's plain output: branded for runtime options, bare otherwise. */
  #plain(k: K): K | Key {
    return this.#s.runtime ? brandKey(k) : k;
  }

  readDetail(id: string, outcome: Outcome): Ranked<K> {
    return this.#readRanked(id, outcome);
  }

  readPlain(
    id: string,
    outcome: Outcome,
    t: Thresholds,
    or: Fallback<Out> | undefined,
  ): K | Key | Out {
    const r = this.#readRanked(id, outcome);
    if (!r.unsure) return this.#plain(r.choice);
    // The ladder: the question's own fallback, then the descriptor's, then the typed error.
    if (or !== undefined) return or.value;
    const descriptorFallback = this.#s.fallbackKey;
    if (descriptorFallback !== undefined) return this.#plain(descriptorFallback);
    throw unsureError(id, r.confidence, t.minConfidence);
  }

  get detailed(): boolean {
    return this.#s.detailed;
  }

  get fallback(): Fallback<Out> | undefined {
    return this.#s.or;
  }
}

/**
 * Everything a score question carries. There is no `fallbackKey`: a scale has no member to
 * fall back to, so the ladder has two rungs rather than three.
 */
interface ScoreState<K extends string, Out> {
  readonly instructions: Instructions;
  readonly keys: readonly K[];
  readonly rubrics: readonly LevelRubric[];
  readonly policy: Policy;
  readonly or: Fallback<Out> | undefined;
  readonly detailed: boolean;
  /**
   * Built from runtime levels rather than from a descriptor, so the plain answer is a branded
   * {@link Rank} — the level's index, which is what {@link scoreLevels} declares.
   */
  readonly runtime: boolean;
}

class ScoreImpl<K extends string, Out> {
  readonly kind = "score" as const;
  readonly #s: ScoreState<K, Out>;

  constructor(s: ScoreState<K, Out>) {
    this.#s = s;
    Object.freeze(this);
  }

  with(policy: Policy): ScoreQuestion<K, Out> {
    return new ScoreImpl({ ...this.#s, policy: over(policy, this.#s.policy) });
  }
  minConfidence(c: number): ScoreQuestion<K, Out> {
    return this.with({ minConfidence: c });
  }
  or(value: Out): ScoreQuestion<K, Out> {
    return new ScoreImpl({ ...this.#s, or: { value } });
  }
  detail(): DetailedScoreQuestion<Scored<K>> {
    return new ScoreImpl<K, Scored<K>>({ ...this.#s, or: undefined, detailed: true });
  }

  encode(base: Policy): Encoded {
    const n = this.#s.keys.length;
    if (n < MIN_LEVELS || n > MAX_LEVELS) {
      throw configError(
        `a score needs ${String(MIN_LEVELS)}..=${String(MAX_LEVELS)} levels, got ${String(n)}`,
      );
    }
    return {
      wire: {
        type: "score",
        instructions: this.#s.instructions,
        criteria: renderLevels(this.#s.rubrics),
      },
      thresholds: settle(over(this.#s.policy, base)),
    };
  }

  #readScored(id: string, outcome: Outcome): Scored<K> {
    if (outcome.kind !== "score") throw mismatch(id, "score", outcome.kind);
    const keys = this.#s.keys;
    if (outcome.distribution.length !== keys.length) {
      throw protocolError(
        `question ${id}: answer has ${String(outcome.distribution.length)} levels, question has ${String(keys.length)}`,
      );
    }
    const at = (i: number): K => {
      const k = keys[i];
      if (k === undefined) {
        throw protocolError(`question ${id}: level ${String(i)} is not in the rubric`);
      }
      return k;
    };
    return {
      value: outcome.value,
      level: at(outcome.index),
      confidence: outcome.confidence,
      unsure: outcome.unsure,
      distribution: outcome.distribution.map((p, i) => [at(i), p] as const),
    };
  }

  readDetail(id: string, outcome: Outcome): Scored<K> {
    return this.#readScored(id, outcome);
  }

  readPlain(
    id: string,
    outcome: Outcome,
    t: Thresholds,
    or: Fallback<Out> | undefined,
  ): K | Rank | Out {
    const s = this.#readScored(id, outcome);
    if (!s.unsure) {
      return this.#s.runtime ? brandRank(this.#s.keys.indexOf(s.level)) : s.level;
    }
    if (or !== undefined) return or.value;
    // No descriptor fallback for a score: `levels()` rejects `fallback(..)` by type, because a
    // scale is an order rather than a set of alternatives.
    throw unsureError(id, s.confidence, t.minConfidence);
  }

  get detailed(): boolean {
    return this.#s.detailed;
  }

  get fallback(): Fallback<Out> | undefined {
    return this.#s.or;
  }
}

/** The internal union, and the guard whose body is what justifies the narrowing. */
type Impl = NoulImpl<unknown> | ChoiceImpl<string, unknown> | ScoreImpl<string, unknown>;

const isImpl = (q: unknown): q is Impl =>
  q instanceof NoulImpl || q instanceof ChoiceImpl || q instanceof ScoreImpl;

/** A yes/no question. Plain output: `boolean`. */
export const noul = (instructions: Instructions): NoulQuestion =>
  new NoulImpl({
    instructions,
    criteria: undefined,
    policy: {},
    or: undefined,
    detailed: false,
  });

/** Pick one of a descriptor's options. Plain output: the descriptor's key union. */
export const choose = <K extends string>(
  options: ChoiceDescriptor<K>,
  instructions: Instructions,
): ChoiceQuestion<K> =>
  new ChoiceImpl({
    instructions,
    keys: options.keys,
    rubrics: options.rubrics,
    fallbackKey: options.fallbackKey,
    policy: {},
    or: undefined,
    detailed: false,
    runtime: false,
  });

/** Rate on a descriptor's levels. Plain output: the argmax level. */
export const score = <K extends string>(
  scale: LevelsDescriptor<K>,
  instructions: Instructions,
): ScoreQuestion<K> =>
  new ScoreImpl({
    instructions,
    keys: scale.keys,
    rubrics: scale.rubrics,
    policy: {},
    or: undefined,
    detailed: false,
    runtime: false,
  });

/**
 * Pick one of runtime options: key to rubric, or `null` for an option described not at all.
 * Plain output: {@link Key}. Every rule {@link choice} enforces at declaration is enforced
 * here, because this constructor holds the whole set at once.
 */
export const chooseAmong = (
  instructions: Instructions,
  options: Readonly<Record<string, OptionRubric | null>>,
): ChoiceQuestion<string, Key> => {
  const keys = Object.keys(options);
  const rubrics = keys.map((k) => options[k] ?? null);
  return new ChoiceImpl<string, Key>({
    instructions,
    keys,
    rubrics,
    // Always `undefined`: `"runtime"` refuses a marked option rather than naming one.
    fallbackKey: checkedOptions(keys, rubrics, "runtime"),
    policy: {},
    or: undefined,
    detailed: false,
    runtime: true,
  });
};

/**
 * Rate on runtime levels, low to high. A bare string is a rubric with no parts. Plain output:
 * {@link Rank}. A counterexample on a level is refused here, as it is a type error under
 * {@link levels}.
 */
export const scoreLevels = (
  instructions: Instructions,
  scale: readonly (string | LevelRubric)[],
): ScoreQuestion<string, Rank> => {
  const rubrics = scale.map((l) => asLevelRubric(l));
  // Rules 6 and 10 fire here, and every single-rubric rule with them.
  renderLevels(rubrics);
  return new ScoreImpl<string, Rank>({
    instructions,
    keys: rubrics.map((_, i) => String(i)),
    rubrics,
    policy: {},
    or: undefined,
    detailed: false,
    runtime: true,
  });
};

/**
 * Turn a question into its wire body and its settled thresholds. Internal: `src/ask.ts` is
 * the only caller in `src`, and `test/rubric-rules.test.ts` uses it to read the bytes a
 * rubric reached the wire as.
 */
export const encodeQuestion = (q: AnyQuestion, base: Policy): Encoded => {
  if (!isImpl(q)) {
    throw configError(
      "not a guideme question; build one with noul(), choose(), score(), chooseAmong() or scoreLevels()",
    );
  }
  const impl: Impl = q;
  return impl.encode(base);
};

/** Read one resolved outcome back into the question's output. Internal. */
export const readAnswer = (
  q: AnyQuestion,
  id: string,
  outcome: Outcome,
  t: Thresholds,
): unknown => {
  if (!isImpl(q)) {
    throw configError(
      "not a guideme question; build one with noul(), choose(), score(), chooseAmong() or scoreLevels()",
    );
  }
  const impl: Impl = q;
  if (impl.detailed) return impl.readDetail(id, outcome);
  switch (impl.kind) {
    case "noul":
      return impl.readPlain(id, outcome, t, impl.fallback);
    case "choice":
      return impl.readPlain(id, outcome, t, impl.fallback);
    case "score":
      return impl.readPlain(id, outcome, t, impl.fallback);
    default:
      return assertNever(impl);
  }
};
