/**
 * The stable, low-cardinality name of a failure. Exactly the nine values Rust's
 * `Error::kind()` returns, because this is the `error.type` span attribute and a dashboard
 * groups every guideme SDK by it.
 */
export type ErrorKind =
  | "auth"
  | "invalid"
  | "rate_limited"
  | "overloaded"
  | "transport"
  | "unexpected_status"
  | "protocol"
  | "unsure"
  | "config";

/** Options a {@link GuidemeError} may carry beyond its message. */
export interface GuidemeErrorOptions {
  /** The underlying failure, for a transport error. */
  readonly cause?: unknown;
  /** The `retry-after` the API last sent, in milliseconds. Only on rate limits and overloads. */
  readonly retryAfterMs?: number;
  /** The HTTP status, only on `unexpected_status`. */
  readonly status?: number;
  /** The verbatim response body, only on `invalid` and `unexpected_status`. */
  readonly body?: string;
  /** The question id, only on `unsure`. */
  readonly question?: string;
}

/**
 * Everything that can go wrong, from the wire to the policy, as one class with a `kind`
 * discriminant. There is no subclass: `kind` is what you branch on, and it is a closed union,
 * so a `switch` over it is checked for exhaustiveness.
 */
export class GuidemeError extends Error {
  /** Which failure this is. */
  readonly kind: ErrorKind;
  /** The `retry-after` the API last sent, in milliseconds; `undefined` when it sent none. */
  readonly retryAfterMs: number | undefined;
  /** The HTTP status, on `unexpected_status`. */
  readonly status: number | undefined;
  /** The verbatim response body, on `invalid` and `unexpected_status`. Never on a span. */
  readonly body: string | undefined;
  /** The question id, on `unsure`. */
  readonly question: string | undefined;

  constructor(kind: ErrorKind, message: string, options?: GuidemeErrorOptions) {
    super(message, options?.cause === undefined ? {} : { cause: options.cause });
    this.name = "GuidemeError";
    this.kind = kind;
    this.retryAfterMs = options?.retryAfterMs;
    this.status = options?.status;
    this.body = options?.body;
    this.question = options?.question;
  }
}

/** Bad configuration: thresholds, a rubric, an empty batch, a missing key. */
export const configError = (detail: string): GuidemeError =>
  new GuidemeError("config", `configuration error: ${detail}`);

/** The response violated the contract. */
export const protocolError = (detail: string): GuidemeError =>
  new GuidemeError("protocol", `protocol violation: ${detail}`);

/** A connection, TLS or body failure. */
export const transportError = (detail: string, cause: unknown): GuidemeError =>
  new GuidemeError("transport", `transport failure: ${detail}`, { cause });

/** The policy said unsure and no fallback was given. */
export const unsureError = (question: string, value: number, threshold: number): GuidemeError =>
  new GuidemeError(
    "unsure",
    `unsure answer for question ${question}: ${String(value)} against threshold ${String(threshold)}`,
    { question },
  );

/**
 * The `default` arm of every `switch` over one of this package's own unions. Reaching it means
 * a variant was added without updating the match, which the compiler catches at the call site.
 */
export const assertNever = (value: never): never => {
  throw protocolError(`unreachable variant: ${JSON.stringify(value)}`);
};
