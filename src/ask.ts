import { assertNever, configError, protocolError } from "./errors.js";
import { encodeQuestion, readAnswer } from "./question.js";
import type { AnyQuestion, ChoiceQuestion, NoulQuestion, ScoreQuestion } from "./question.js";
import type { Outcome, Policy, Thresholds } from "./policy.js";
import type { WireQuestion } from "./api/wire.js";

/** Anything `Guide.ask` can answer in one request. */
export type Shape =
  | NoulQuestion<unknown>
  | ChoiceQuestion<string, unknown>
  | ScoreQuestion<string, unknown>
  | readonly Shape[]
  | { readonly [k: string]: Shape };

/**
 * The answer shape: the same shape, each question replaced by its answer.
 *
 * `number extends S["length"]` is the tuple test: it is true only for a non-tuple array, so an
 * `as const` tuple takes the positional branch and a plain array takes the element branch. The
 * question branches come first so a question is never mistaken for an object.
 */
export type Answered<S> =
  S extends NoulQuestion<infer O>
    ? O
    : S extends ChoiceQuestion<string, infer O>
      ? O
      : S extends ScoreQuestion<string, infer O>
        ? O
        : S extends readonly unknown[]
          ? number extends S["length"]
            ? readonly Answered<S[number]>[]
            : { readonly [I in keyof S]: Answered<S[I]> }
          : S extends Readonly<Record<string, unknown>>
            ? { readonly [K in keyof S]: Answered<S[K]> }
            : never;

/**
 * A `Claim` mirrors the shape the caller passed, with each question replaced by the id it was
 * given and the question itself. Decoding walks the claim rather than the caller's object, so
 * a shape is traversed exactly once and the same object cannot be walked twice with different
 * results.
 */
export type Claim =
  | { readonly at: "question"; readonly id: string; readonly question: AnyQuestion }
  | { readonly at: "list"; readonly items: readonly Claim[] }
  | { readonly at: "map"; readonly entries: readonly (readonly [string, Claim])[] };

/** Questions accumulated for one request, with each one's settled thresholds. */
export interface Plan {
  /** Questions keyed `q0..qN`, in insertion order. */
  readonly questions: Record<string, WireQuestion>;
  /** Each question's settled thresholds. */
  readonly thresholds: Record<string, Thresholds>;
  /** The shape mirror to decode with. */
  readonly claim: Claim;
}

/**
 * A guideme question. The body is the check that justifies the narrowing: the three question
 * classes are the only values in this package carrying a `kind` of `"noul"`, `"choice"` or
 * `"score"`, and `encodeQuestion` re-checks with `instanceof` before it trusts one.
 */
const isQuestion = (v: unknown): v is AnyQuestion =>
  typeof v === "object" &&
  v !== null &&
  "kind" in v &&
  (v.kind === "noul" || v.kind === "choice" || v.kind === "score");

/** Walk a shape in encounter order, encode every question, and mint `q0..qN`. */
export const encodeShape = (shape: Shape, base: Policy): Plan => {
  const questions: Record<string, WireQuestion> = {};
  const thresholds: Record<string, Thresholds> = {};

  const walk = (node: Shape): Claim => {
    if (isQuestion(node)) {
      const id = `q${String(Object.keys(questions).length)}`;
      const encoded = encodeQuestion(node, base);
      questions[id] = encoded.wire;
      thresholds[id] = encoded.thresholds;
      return { at: "question", id, question: node };
    }
    if (Array.isArray(node)) {
      const items: readonly Shape[] = node;
      return { at: "list", items: items.map((item) => walk(item)) };
    }
    if (typeof node === "object") {
      // `Object.keys` is the encounter order for a plain object, which is insertion order
      // except for integer-like keys; docs/contract.md records that.
      return {
        at: "map",
        entries: Object.entries(node).map(([k, v]) => [k, walk(v)] as const),
      };
    }
    // The one catch-all in this file, and it is over a value the type system never saw, not
    // over one of this package's unions.
    throw configError("a shape is a question, a tuple or array of shapes, or an object of shapes");
  };

  const claim = walk(shape);
  return { questions, thresholds, claim };
};

/** One resolved answer: what the policy concluded, and the thresholds behind it. */
export interface Reply {
  /** The policy's reading. */
  readonly outcome: Outcome;
  /** The thresholds that produced it. */
  readonly thresholds: Thresholds;
}

/**
 * Rebuild the caller's shape from the resolved outcomes. Returns `unknown`: `Guide.ask` is
 * where it becomes `Answered<S>`, and that is the only place in `src/` where the shape type
 * and the runtime value meet.
 */
export const decodeShape = (claim: Claim, replies: Readonly<Record<string, Reply>>): unknown => {
  switch (claim.at) {
    case "question": {
      const reply = replies[claim.id];
      if (reply === undefined) {
        throw protocolError(`no answer for question ${claim.id}`);
      }
      return readAnswer(claim.question, claim.id, reply.outcome, reply.thresholds);
    }
    case "list":
      return claim.items.map((item) => decodeShape(item, replies));
    case "map":
      return Object.fromEntries(
        claim.entries.map(([k, c]) => [k, decodeShape(c, replies)] as const),
      );
    default:
      return assertNever(claim);
  }
};
