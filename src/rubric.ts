import { configError } from "./errors.js";
import { isBlank } from "./scalars.js";

// The three primitives, each named rather than idiomatic. Design note §11: a prose rule whose
// wording matches a built-in's name will diverge, so the primitive is pinned here and the
// alternative that must never be used is named beside it.

// Blank is imported above, not redefined: `src/scalars.ts` owns the one definition, because a
// blank API key and a blank model are refused with the same predicate. `docs/contract.md`
// names the primitive here, where the rule lives; the implementation is one function.

// Duplicate: exact string equality, no trimming, no case folding, no Unicode normalisation.
// NEVER a Set of normalised keys and NEVER `localeCompare`: `"a"` and `" a"` are two different
// examples and both are legal. Rules 4, 5-7 and 8 all ask this one question — within a clause,
// across rubrics, and between a rubric's examples and its counterexamples — so all three call
// this, and the definition lives once.
const isDuplicate = (earlier: readonly string[], item: string): boolean =>
  earlier.some((seen) => seen === item);

// Line break: `contains` over exactly U+000A and U+000D. NEVER `split(/\r?\n/)`, NEVER `/\s/`,
// NEVER `/\p{Cc}/`: those cover different sets and would leave two SDKs disagreeing about
// U+2028, which is deliberately legal here.
const hasLineBreak = (item: string): boolean => item.includes("\n") || item.includes("\r");

/** The parts a rubric in an option position may carry. */
export interface OptionParts {
  /** Inputs that belong to this option. A written-out empty list is refused. */
  readonly examples?: readonly string[];
  /** Inputs that do not belong to this option. A written-out empty list is refused. */
  readonly counterexamples?: readonly string[];
}

/** The parts a rubric in a level position may carry. A level takes no counterexamples. */
export interface LevelParts {
  /** Inputs that score at this level. A written-out empty list is refused. */
  readonly examples?: readonly string[];
}

/**
 * A description of an option, plus the inputs that belong to it and the ones that do not.
 * Built by {@link option} or {@link fallback}; never by hand.
 */
export interface OptionRubric {
  /** Discriminant, so `levels()` rejects this by type. */
  readonly rubric: "option";
  /** What this option means. Used verbatim: never trimmed, never re-punctuated. */
  readonly what: string;
  /** Inputs that belong here, in declaration order. */
  readonly examples: readonly string[];
  /** Inputs that do not, in declaration order. */
  readonly counterexamples: readonly string[];
  /** Set by {@link fallback}: the option the unsure ladder falls back to. */
  readonly isFallback: boolean;
}

/**
 * A description of a level, plus the inputs that score there. Built by {@link level} or by a
 * bare string; never by hand.
 */
export interface LevelRubric {
  /** Discriminant, so an {@link OptionRubric} is a type error in a level position. */
  readonly rubric: "level";
  /** What this level means. Used verbatim. */
  readonly what: string;
  /** Inputs that score here, in declaration order. */
  readonly examples: readonly string[];
}

/** Either kind, for the renderer, which treats them identically. */
export type AnyRubric = OptionRubric | LevelRubric;

const clause = (
  written: readonly string[] | undefined,
  kind: "example" | "counterexample",
): readonly string[] => {
  if (written === undefined) return [];
  // Rule 1. The caller wrote the clause and put nothing in it.
  if (written.length === 0) {
    throw configError(`an ${kind} clause was written with nothing in it`);
  }
  return written;
};

/**
 * Describe an option. `what` is used verbatim; `examples` and `counterexamples` render in
 * declaration order.
 */
export const option = (what: string, parts?: OptionParts): OptionRubric =>
  Object.freeze({
    rubric: "option",
    what,
    examples: Object.freeze(clause(parts?.examples, "example")),
    counterexamples: Object.freeze(clause(parts?.counterexamples, "counterexample")),
    isFallback: false,
  });

/** {@link option}, marked as the option the unsure ladder falls back to. */
export const fallback = (what: string, parts?: OptionParts): OptionRubric =>
  Object.freeze({ ...option(what, parts), isFallback: true });

/**
 * Describe a level. There is no `counterexamples` parameter: a level is a position on an
 * ordered scale, not an option to rule out.
 */
export const level = (what: string, parts?: LevelParts): LevelRubric =>
  Object.freeze({
    rubric: "level",
    what,
    examples: Object.freeze(clause(parts?.examples, "example")),
  });

/** A bare string is a rubric with no parts. */
export const asLevelRubric = (v: string | LevelRubric): LevelRubric =>
  typeof v === "string" ? level(v) : v;

const checkClause = (items: readonly string[], kind: "example" | "counterexample"): void => {
  // `entries()` rather than an index: there is no `items[i]` that can be absent, so there is
  // no fallback to write, and a `?? ""` here would turn a missing item into a legal blank one.
  for (const [i, item] of items.entries()) {
    // Rules 2 and 3.
    if (isBlank(item)) throw configError(`an ${kind} must not be empty`);
    // Rules 11 and 12.
    if (hasLineBreak(item)) {
      throw configError(
        `an ${kind} may not contain a line break (U+000A or U+000D): ${JSON.stringify(item)}`,
      );
    }
    // Rule 4.
    if (isDuplicate(items.slice(0, i), item)) {
      throw configError(`duplicate ${kind} ${JSON.stringify(item)}`);
    }
  }
};

/**
 * Check, then compose the parts into the one string the API takes.
 *
 * `docs/contract.md` §3 pins these bytes. With no examples and no counterexamples the output
 * is `what` itself, byte for byte — that is what makes every rubric written before this
 * feature put the same bytes on the wire.
 */
export const render = (r: AnyRubric): string => {
  const counterexamples = r.rubric === "option" ? r.counterexamples : [];
  // Rule 9, checked FIRST: the contract says that where a rubric breaks this and another rule
  // at once, this is the one reported.
  if (isBlank(r.what) && (r.examples.length > 0 || counterexamples.length > 0)) {
    throw configError("examples need a non-empty rubric to attach to");
  }
  checkClause(r.examples, "example");
  checkClause(counterexamples, "counterexample");
  // Rule 8.
  for (const example of r.examples) {
    if (isDuplicate(counterexamples, example)) {
      throw configError(
        `${JSON.stringify(example)} is both an example and a counterexample; it cannot be in and out of the same option`,
      );
    }
  }
  const lines = [r.what];
  if (r.examples.length > 0) lines.push(`Examples: ${r.examples.join("; ")}`);
  if (counterexamples.length > 0) {
    lines.push(`Not this option: ${counterexamples.join("; ")}`);
  }
  return lines.join("\n");
};

/**
 * Rules 5, 6 and 7 — the ones no single rubric can see. An example asserts that an input
 * belongs here, so the same string under two of them asserts it belongs to each.
 *
 * Each rubric arrives paired with the label the error message names it by, rather than with a
 * function from an index to a label. A pair cannot be indexed out of range, so no branch here
 * has to invent a rubric or a label that is not there.
 */
const checkShared = (
  labelled: readonly (readonly [string, AnyRubric])[],
  noun: "option" | "level",
): void => {
  for (const [i, [label, here]] of labelled.entries()) {
    for (const example of here.examples) {
      for (const [earlierLabel, earlier] of labelled.slice(0, i)) {
        if (isDuplicate(earlier.examples, example)) {
          throw configError(
            `${JSON.stringify(example)} is an example of both ${earlierLabel} and ${label}; an input belongs to one ${noun}`,
          );
        }
      }
    }
  }
};

/**
 * Check a noul's yes/no pair against each other, then render both.
 *
 * Both sides are {@link OptionRubric}, never a {@link LevelRubric}: a yes and a no are two
 * alternatives rather than two positions on a scale, so either may carry counterexamples and a
 * level may not.
 *
 * **Rust has no such split.** It has one `Rubric`, and `render_pair(yes: &Rubric, no: &Rubric)`
 * takes it on both sides; the no-counterexample-on-a-level rule lives in `render_levels` as a
 * runtime check and in `#[derive(Levels)]` as a compile error. The two types here are the
 * TypeScript strengthening the goal asks for — the rule becomes a type error at every call
 * site, on every path — and they refuse and accept exactly the declarations Rust does.
 */
export const renderPair = (yes: OptionRubric, no: OptionRubric): readonly [string, string] => {
  checkShared(
    [
      ["yes", yes],
      ["no", no],
    ],
    "option",
  );
  return [render(yes), render(no)];
};

/**
 * Check a choice's options against each other, then render each. A key with no rubric stays
 * `null`: the wire distinguishes an option described as nothing from one not described.
 */
export const renderOptions = (
  options: readonly (readonly [string, OptionRubric | null])[],
): readonly (readonly [string, string | null])[] => {
  const described = options.filter(
    (entry): entry is readonly [string, OptionRubric] => entry[1] !== null,
  );
  checkShared(
    described.map(([k, r]) => [JSON.stringify(k), r] as const),
    "option",
  );
  return options.map(([k, r]) => [k, r === null ? null : render(r)] as const);
};

/** Check a score's levels against each other, then render each. */
export const renderLevels = (levels: readonly LevelRubric[]): readonly string[] => {
  // Rule 10, checked FIRST across every level, exactly as `render_levels` does in Rust.
  // `levels()` makes this a type error; this is the same rule where there is no declaration.
  for (const [i, declared] of levels.entries()) {
    const maybeOption: unknown = declared;
    if (
      typeof maybeOption === "object" &&
      maybeOption !== null &&
      // `in` narrows `maybeOption` to carry the property, and `Array.isArray` narrows the
      // property itself, so neither line needs a cast. This path exists for values the type
      // system never saw: a caller can hand `scoreLevels` an `OptionRubric` through `unknown`.
      "counterexamples" in maybeOption &&
      Array.isArray(maybeOption.counterexamples) &&
      maybeOption.counterexamples.length > 0
    ) {
      throw configError(
        `a counterexample is not allowed on level ${String(i)}; a level is a position on a scale, not an option to rule out`,
      );
    }
  }
  checkShared(
    levels.map((l, i) => [`level ${String(i)}`, l] as const),
    "level",
  );
  return levels.map((l) => render(l));
};
