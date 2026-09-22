import { configError, protocolError } from "./errors.js";
import { over, resolve, settle } from "./policy.js";
import type { Policy } from "./policy.js";
import { ApiKey, LATEST_MODEL, model } from "./scalars.js";
import type { Model } from "./scalars.js";
import { createClient } from "./api/client.js";
import type { Client } from "./api/client.js";
import { decodeShape, encodeShape } from "./ask.js";
import type { Answered, Reply, Shape } from "./ask.js";
import { answerEvent, askSpan, failAskSpan } from "./telemetry.js";
import type { ModelInfo, Receipt } from "./receipt.js";

/** How to build a {@link Guide}. */
export interface GuideOptions {
  /** The API key. Required unless {@link Guide.fromEnv} supplies it. */
  readonly apiKey: ApiKey;
  /** The API origin. Default `https://api.typesafe.ai`. */
  readonly baseUrl?: string;
  /** The model or alias. Default `jev-latest`. */
  readonly model?: Model;
  /** The guide-wide policy patch. Validated at construction. */
  readonly policy?: Policy;
  /** Retries for 429, 529 and a failure to connect. Default 3. */
  readonly maxRetries?: number;
  /** Base delay for exponential backoff, in milliseconds. Default 500. */
  readonly backoff?: number;
  /** Deadline per attempt, in milliseconds. Default 30 000. */
  readonly timeout?: number;
  /** Record the state JSON on the span. Off by default: state is user data. */
  readonly recordState?: boolean;
  /** Send through this `fetch` instead of the global one. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What {@link Guide.withPolicy} builds a derived guide from: everything but the key. */
type DerivedOptions = Omit<GuideOptions, "apiKey">;

/** A user-defined type guard whose body is the check that justifies the narrowing. */
const hasApiKey = (o: GuideOptions | DerivedOptions): o is GuideOptions => "apiKey" in o;

/** Read one environment variable, or `undefined` where there is no environment. */
const env = (name: string): string | undefined =>
  typeof process === "undefined" ? undefined : process.env[name];

/** The key from the environment. Its absence is the caller's mistake, so it is loud. */
const keyFromEnv = (): ApiKey => {
  const raw = env("TYPESAFE_API_KEY");
  if (raw === undefined) throw configError("TYPESAFE_API_KEY is not set");
  return new ApiKey(raw);
};

/** The model named by `GUIDEME_MODEL`, or nothing, which leaves the default in place. */
const modelFromEnv = (): Model | undefined => {
  const raw = env("GUIDEME_MODEL");
  return raw === undefined ? undefined : model(raw);
};

/**
 * This guide's own transport. Every unset field is omitted rather than passed as `undefined`,
 * so the client's own defaults are what fills them in.
 */
const ownClient = (options: GuideOptions | DerivedOptions): Client => {
  if (!hasApiKey(options)) throw configError("api_key is required");
  return createClient({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
};

/** A non-null object, including an array, viewed as the record its fields form. */
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null;

/**
 * Serialise the caller's state once, refusing what JSON would silently corrupt.
 *
 * `JSON.stringify(NaN)` is `"null"`, which the API reads as an absent field, so the walk
 * refuses a non-finite number before the encoder can substitute. Loud beats silent.
 */
const encodeState = (state: unknown): string => {
  const seen = new WeakSet<object>();
  const check = (v: unknown): void => {
    if (typeof v === "number" && !Number.isFinite(v)) {
      throw configError(`state is not serialisable: ${String(v)} has no JSON representation`);
    }
    if (typeof v === "bigint") {
      throw configError("state is not serialisable: a bigint has no JSON representation");
    }
    if (isRecord(v)) {
      if (seen.has(v)) throw configError("state is not serialisable: it contains a cycle");
      seen.add(v);
      for (const entry of Object.values(v)) check(entry);
    }
  };
  check(state);
  let json: string | undefined;
  try {
    json = stringified(state);
  } catch (e) {
    throw configError(`state is not serialisable: ${String(e)}`);
  }
  return json ?? "null";
};

/**
 * `JSON.stringify`, typed as it behaves. The lib declares it returning `string`, but
 * `JSON.stringify(undefined)` really is `undefined`, and this is what makes the caller's
 * fallback a check rather than dead code.
 */
const stringified = (v: unknown): string | undefined => JSON.stringify(v);

/**
 * A configured entry point to Jev.
 *
 * One `Guide` per process, shared freely: `ask` holds no state between calls and the object
 * is immutable after construction. There is no `close()` — `fetch` owns no pool, so there is
 * nothing to release — and no synchronous `ask`, because no synchronous `fetch` exists.
 */
export class Guide {
  readonly #client: Client;
  readonly #model: Model;
  readonly #policy: Policy;
  readonly #recordState: boolean;

  /**
   * Build a guide.
   *
   * `transport` is the internal seam {@link Guide.withPolicy} uses to share one client
   * between two guides. It is in no exported type, so a caller cannot reach it, and it is why
   * a derived guide is an ordinary construction rather than a clone: a `#private` field
   * cannot be read from outside its instance, so there is nothing to copy.
   */
  constructor(options: GuideOptions | DerivedOptions, transport?: Client) {
    // Validated here so a bad house policy fails at startup rather than at the first ask.
    settle(options.policy ?? {});
    this.#client = transport ?? ownClient(options);
    this.#model = options.model ?? LATEST_MODEL;
    this.#policy = options.policy ?? {};
    this.#recordState = options.recordState ?? false;
    Object.freeze(this);
  }

  /** Read `TYPESAFE_API_KEY` (required), `TYPESAFE_BASE_URL` and `GUIDEME_MODEL`. */
  static fromEnv(overrides?: Partial<GuideOptions>): Guide {
    const apiKey = overrides?.apiKey ?? keyFromEnv();
    const baseUrl = overrides?.baseUrl ?? env("TYPESAFE_BASE_URL");
    const named = overrides?.model ?? modelFromEnv();
    return new Guide({
      ...overrides,
      apiKey,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(named === undefined ? {} : { model: named }),
    });
  }

  /** A guide sharing this transport with `policy` patched over this guide's. */
  withPolicy(policy: Policy): Guide {
    const merged = over(policy, this.#policy);
    settle(merged); // validated now, so a bad patch fails where it is written
    return new Guide(
      { model: this.#model, policy: merged, recordState: this.#recordState },
      this.#client,
    );
  }

  /** Ask one shape and get the answer, the model that produced it and what it cost. */
  async askWithReceipt<S extends Shape>(shape: S, state: unknown): Promise<Receipt<Answered<S>>> {
    const json = encodeState(state);
    const plan = encodeShape(shape, this.#policy);
    if (Object.keys(plan.questions).length === 0) {
      throw configError("a batch needs at least one question");
    }

    const span = askSpan({
      model: this.#model,
      host: this.#client.server.host,
      port: this.#client.server.port,
      questions: Object.keys(plan.questions).length,
      // Rust records `state_json.len()`, which is bytes; a JavaScript string's `.length` is
      // UTF-16 code units, and the field name says bytes.
      stateBytes: new TextEncoder().encode(json).byteLength,
      ...(this.#recordState ? { state: json } : {}),
    });

    try {
      // Everything below runs with the ask span ACTIVE, which is what makes each HTTP attempt
      // span its child rather than a root of its own.
      return await span.run(async () => {
        const parsedState: unknown = JSON.parse(json);
        const response = await this.#client.evaluate({
          state: parsedState,
          model: this.#model,
          questions: plan.questions,
        });
        span.response(response.model, response.usage.input_tokens, response.usage.output_tokens);

        const replies: Record<string, Reply> = {};
        for (const [id, thresholds] of Object.entries(plan.thresholds)) {
          const answer = response.answers[id];
          if (answer === undefined) throw protocolError(`no answer for question ${id}`);
          const outcome = resolve(answer, thresholds);
          answerEvent(span, id, outcome, thresholds);
          replies[id] = { outcome, thresholds };
        }

        // The one `as` in src/ outside the branded-scalar constructors. `decodeShape` walks a
        // `Claim`, which has erased `S` by construction; threading `S` through `Claim` would
        // make it a recursive generic mirroring `Shape` and produce the same value.
        // eslint-disable-next-line no-restricted-syntax -- Claim erased S by construction; the shape-to-answer relationship is this method's return type, proven for every shape in test/typing.test-d.ts
        const answer = decodeShape(plan.claim, replies) as Answered<S>;
        return Object.freeze({
          answer,
          model: model(response.model),
          usage: Object.freeze({
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }),
        });
      });
    } catch (e) {
      failAskSpan(span, e);
      throw e;
    } finally {
      span.end();
    }
  }

  /** Ask one shape and get the answer. A batch is atomic: one bad answer fails the call. */
  async ask<S extends Shape>(shape: S, state: unknown): Promise<Answered<S>> {
    return (await this.askWithReceipt(shape, state)).answer;
  }

  /** What `GET /v1/models` lists, copied into this package's own shape. */
  async models(): Promise<readonly ModelInfo[]> {
    const wire = await this.#client.models();
    return wire.map((m) =>
      Object.freeze({ name: m.name, description: m.description, releaseDate: m.release_date }),
    );
  }

  /** Redacted: the key is never part of any string form of a guide. */
  toString(): string {
    return `Guide(model=${this.#model})`;
  }
}
