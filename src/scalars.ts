import { configError, protocolError } from "./errors.js";

/** A probability in the closed unit interval, validated once at the wire. */
export type Probability = number & { readonly __brand: "Probability" };

/** A confidence in the closed unit interval, validated once at the wire. */
export type Confidence = number & { readonly __brand: "Confidence" };

/** A model name or alias accepted by the API's `model` field. */
export type Model = string & { readonly __brand: "Model" };

/** A runtime option key, from `chooseAmong`. */
export type Key = string & { readonly __brand: "Key" };

/** A runtime level index, from `scoreLevels`. */
export type Rank = number & { readonly __brand: "Rank" };

const inUnitInterval = (n: number): boolean => n >= 0 && n <= 1;

/** Validate a probability. Outside `0..=1`, or not a number, is a protocol violation. */
export const probability = (n: number): Probability => {
  if (!inUnitInterval(n)) throw protocolError(`probability ${String(n)} is outside 0..=1`);
  // eslint-disable-next-line no-restricted-syntax -- checked on the line above; this is the one place the brand is applied
  return n as Probability;
};

/** Validate a confidence. Outside `0..=1`, or not a number, is a protocol violation. */
export const confidence = (n: number): Confidence => {
  if (!inUnitInterval(n)) throw protocolError(`confidence ${String(n)} is outside 0..=1`);
  // eslint-disable-next-line no-restricted-syntax -- checked on the line above; this is the one place the brand is applied
  return n as Confidence;
};

/**
 * Blank: empty once characters with the Unicode `White_Space` property are removed from both
 * ends. **Defined once, here**, and imported by `src/rubric.ts`, which is where the contract
 * pins it as one of its three named primitives. Two copies of a contract primitive are two
 * rules waiting to diverge, which is the whole subject of design note §11.
 *
 * NEVER `String.prototype.trim()`: ECMAScript's WhiteSpace list is a different set. Measured —
 * `"\u0085".trim().length` is 1 though U+0085 IS `White_Space`, and `"\uFEFF".trim().length`
 * is 0 though U+FEFF is NOT. This regex agrees with Rust's `str::trim` on both.
 */
export const isBlank = (s: string): boolean =>
  s.replace(/^\p{White_Space}+/u, "").replace(/\p{White_Space}+$/u, "").length === 0;

/** Name a model or alias. Refused if blank; stored exactly as written, never trimmed. */
export const model = (id: string): Model => {
  // A blank model is the CALLER's mistake, so it is a `config` error, not a `protocol` one:
  // `error.type = "protocol"` means the API's shape changed, and grouping a typo under it
  // would make a dashboard read a configuration bug as an upstream incident. Rust raises
  // `Error::Config` here for the same reason.
  if (isBlank(id)) throw configError("a model name must not be blank");
  // eslint-disable-next-line no-restricted-syntax -- checked on the line above; this is the one place the brand is applied
  return id as Model;
};

/**
 * Brand a runtime option key. **No check is performed here, and none is possible:** any string
 * is a legal option key. The invariant that makes a `Key` meaningful — that it names an option
 * in the rubric — is established by the only caller, `ChoiceImpl`'s ranked reader in
 * `src/question.ts`, which refuses a key the rubric does not carry before this is reached.
 */
export const key = (k: string): Key =>
  // eslint-disable-next-line no-restricted-syntax -- no check here by design; `ChoiceImpl`'s ranked reader proved the key is in the rubric before calling this
  k as Key;

/**
 * Brand a runtime level index. **No check is performed here**: the invariant is that the index
 * addresses a declared level, which is established by the only caller, `ScoreImpl`'s scored
 * reader in `src/question.ts`, whose count check and level lookup both run first.
 */
export const rank = (i: number): Rank =>
  // eslint-disable-next-line no-restricted-syntax -- no check here by design; `ScoreImpl`'s scored reader proved the index addresses a declared level before calling this
  i as Rank;

/** `jev-latest`: the most recent stable release, and this package's default. */
export const LATEST_MODEL: Model = model("jev-latest");

// The three bounds the API states, in the one module both the policy layer and the wire layer
// already import. Rust keeps them in `api/mod.rs` and lets `policy.rs` import `crate::api`,
// which is the policy-to-api edge the file table here forbids; this placement gives them one
// home without recreating it.

/** Fewest levels a score may carry; one level is not a scale. */
export const MIN_LEVELS = 2;
/** Most levels a score may carry. */
export const MAX_LEVELS = 10;
/** Most options a choice may carry. */
export const MAX_OPTIONS = 255;

const REDACTED = "ApiKey(***)";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * A TypeSafe API key. Every way of turning it into a string yields `ApiKey(***)`, it is never
 * spread, never logged and never a span attribute. {@link ApiKey.expose} is the only way to
 * read it and only `src/api/client.ts` calls it.
 */
export class ApiKey {
  readonly #value: string;

  constructor(value: string) {
    // Refused, never trimmed, and a `config` error for the same reason `model()` raises one:
    // a blank key is the caller's mistake, not the API changing shape.
    if (isBlank(value)) throw configError("an API key must not be blank");
    this.#value = value;
  }

  /** The raw key, for the `Authorization` header. Nothing else may call this. */
  expose(): string {
    return this.#value;
  }

  /** Redacted. */
  toString(): string {
    return REDACTED;
  }

  /** Redacted, so `JSON.stringify` of anything holding a key is safe. */
  toJSON(): string {
    return REDACTED;
  }

  /** Redacted, for `String(key)`, template literals and `+`. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

// Node's `util.inspect` hook, which `console.log` also uses. Installed here rather than in the
// class body because `Symbol.for(..)` is not a `unique symbol` and `isolatedDeclarations`
// cannot name a computed member (TS9038).
Object.defineProperty(ApiKey.prototype, INSPECT, {
  value: (): string => REDACTED,
  writable: false,
  enumerable: false,
  configurable: false,
});

/**
 * Compare two strings by Unicode code point, which is what Rust's `String: Ord` does.
 * JavaScript's `<` compares UTF-16 code units, which orders a supplementary character before
 * `U+E000..U+FFFF`; option keys are the tie-break in `ranked`, so the two SDKs must agree.
 */
export const compareByCodePoint = (a: string, b: string): number => {
  // Code-point decomposition is the point, not a hazard: Rust compares `char`s, so a
  // grapheme cluster must split here exactly as it does there.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are the unit Rust's `String: Ord` compares
  const left = [...a];
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are the unit Rust's `String: Ord` compares
  const right = [...b];
  for (const [i, x] of left.entries()) {
    const y = right[i];
    // `b` ran out first, so `a` is the longer of two equal prefixes.
    if (y === undefined) break;
    // `x` and `y` are whole code points, so their widths decide the comparison on their own:
    // a two-unit string is a surrogate pair and therefore a scalar value at or above U+10000,
    // while a one-unit string is at or below U+FFFF. At equal width, UTF-16 order and
    // code-point order agree. No `?? 0`: there is no index here that can be absent.
    if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
};
