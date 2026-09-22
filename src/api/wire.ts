import { z } from "zod";
import { configError, protocolError } from "../errors.js";
import { MAX_LEVELS, MIN_LEVELS } from "../scalars.js";
import type { Answer } from "../policy.js";

// `Answer` is owned by `src/policy.ts` and imported here, never the other way round: the pure
// decision layer must not depend on the HTTP layer. This module parses INTO that type.

/** Optional descriptions of what a yes and a no mean. The wire spells them `true`/`false`. */
export interface WireNoulCriteria {
  /** What a yes, a value near 1, means. */
  readonly true: string;
  /** What a no, a value near 0, means. */
  readonly false: string;
}

/** One typed question. `type` selects the variant on the wire. */
export type WireQuestion =
  | {
      readonly type: "noul";
      readonly instructions: unknown;
      readonly criteria?: WireNoulCriteria | undefined;
    }
  | {
      readonly type: "choice";
      readonly instructions: unknown;
      readonly criteria: Readonly<Record<string, string | null>>;
    }
  | {
      readonly type: "score";
      readonly instructions: unknown;
      readonly criteria: readonly string[];
    };

/** The request body of `POST /v1/systemone`. */
export interface WireRequest {
  /** What to evaluate. Any JSON value. */
  readonly state: unknown;
  /** Which model answers. */
  readonly model: string;
  /** Questions keyed `q0..qN` in encounter order. */
  readonly questions: Readonly<Record<string, WireQuestion>>;
}

/** Token usage for one request. Input tokens are billed; output tokens are free. */
export interface WireUsage {
  /** Tokens read. */
  readonly input_tokens: number;
  /** Tokens written. */
  readonly output_tokens: number;
}

/** The response body of `POST /v1/systemone`. */
export interface WireResponse {
  /** The versioned model that answered, even when an alias was requested. */
  readonly model: string;
  /** One answer per question, same ids. */
  readonly answers: Readonly<Record<string, Answer>>;
  /** Token usage. */
  readonly usage: WireUsage;
}

/** One entry from `GET /v1/models`. */
export interface WireModelInfo {
  /** Name or alias accepted by the `model` field. */
  readonly name: string;
  /** What it is for. */
  readonly description: string;
  /** Release date as the API reports it. */
  readonly release_date: string;
}

// ---- module-private schemas -------------------------------------------------------------

const unitInterval = z.number().min(0).max(1);
const levelKey = z.string().regex(/^\d+$/u);

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: unitInterval }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), unitInterval),
    confidence: unitInterval,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(levelKey, z.string()),
    probabilities: z.record(levelKey, unitInterval),
    confidence: unitInterval,
  }),
]);

const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
});

const modelsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      release_date: z.string(),
    }),
  ),
});

const noulCriteriaSchema = z.object({ true: z.string(), false: z.string() });

const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: z.unknown(),
    criteria: noulCriteriaSchema.optional(),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: z.unknown(),
    criteria: z.record(z.string(), z.string().nullable()),
  }),
  z.object({
    type: z.literal("score"),
    instructions: z.unknown(),
    criteria: z.array(z.string()).min(MIN_LEVELS).max(MAX_LEVELS),
  }),
]);

const requestSchema = z.object({
  state: z.unknown(),
  model: z.string().min(1),
  questions: z.record(z.string(), questionSchema),
});

// ---- the only exported parse surface ----------------------------------------------------

/**
 * Validate an outgoing `POST /v1/systemone` body before it is sent. The request schema is
 * half of `spec/schema/*.json` and the contract says both halves must validate; a body this
 * package built and cannot validate is a `config` error, because it is this package's
 * mistake rather than the API's.
 */
export const parseRequest = (v: unknown): WireRequest => {
  const parsed = requestSchema.safeParse(v);
  if (!parsed.success) throw configError(`request body: ${parsed.error.message}`);
  return parsed.data;
};

/** Narrow an unknown `POST /v1/systemone` body. A violation is a `protocol` error. */
export const parseResponse = (v: unknown): WireResponse => {
  const parsed = responseSchema.safeParse(v);
  if (!parsed.success) throw protocolError(`response body: ${parsed.error.message}`);
  return parsed.data;
};

/**
 * The JSON Schema these schemas describe, for the drift assertion in `test/wire.test.ts`.
 * `z.toJSONSchema` is part of zod 4, so this needs no second dependency.
 */
export const schemaShapes = (): Readonly<Record<"request" | "response", unknown>> =>
  Object.freeze({
    request: z.toJSONSchema(requestSchema),
    response: z.toJSONSchema(responseSchema),
  });

/** Narrow an unknown `GET /v1/models` body. A violation is a `protocol` error. */
export const parseModels = (v: unknown): readonly WireModelInfo[] => {
  const parsed = modelsSchema.safeParse(v);
  if (!parsed.success) throw protocolError(`response body: ${parsed.error.message}`);
  return parsed.data.models;
};
