import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { GuidemeError, assertNever } from "./errors.js";
import type { ErrorKind } from "./errors.js";
import type { Outcome, Thresholds } from "./policy.js";

// `./policy` is imported for types only, so it is erased and adds no edge at runtime. The
// answer event is shaped by what the policy concluded, and copying `Outcome`'s field names
// into this module would be a second declaration of the same thing.

/** The tracer every span in this package comes from. The library installs no provider. */
const tracer: Tracer = trace.getTracer("guideme");

/** OpenTelemetry attributes are signed integers where the contract says `i64`. */
const int = (n: number): number => Math.trunc(n);

/** A span and the one thing every caller does to it. */
interface SpanHandle {
  /** The underlying span, for events and attributes. */
  readonly span: Span;
  /** Close the span. */
  end(): void;
}

/** One HTTP attempt's span. */
export interface HttpSpan extends SpanHandle {
  /** Record `http.response.status_code`. */
  status(code: number): void;
}

/** The `guideme.ask` span. */
interface AskSpan extends SpanHandle {
  /** Record what the response said, once it has arrived. */
  response(model: string, inputTokens: number, outputTokens: number): void;
}

/** Attributes of one HTTP attempt span. */
interface HttpSpanOptions {
  /** `POST /v1/systemone` or `GET /v1/models`. */
  readonly name: string;
  /** `POST` or `GET`. */
  readonly method: "POST" | "GET";
  /** Host of the base URL. */
  readonly host: string;
  /** Port of the base URL. */
  readonly port: number;
  /** The request URL. Never holds a secret: a base URL with credentials is refused. */
  readonly url: string;
  /** The low-cardinality path. */
  readonly template: string;
  /** Ordinal of the retry; absent on the first attempt. */
  readonly resendCount?: number | undefined;
}

/** One span per HTTP attempt, shaped by the OpenTelemetry HTTP client conventions. */
export const httpSpan = (o: HttpSpanOptions): HttpSpan => {
  const span = tracer.startSpan(o.name, {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": o.method,
      "server.address": o.host,
      "server.port": int(o.port),
      "url.full": o.url,
      "url.template": o.template,
      ...(o.resendCount === undefined ? {} : { "http.request.resend_count": int(o.resendCount) }),
    },
  });
  return {
    span,
    status: (code) => span.setAttribute("http.response.status_code", int(code)),
    end: () => {
      span.end();
    },
  };
};

/** Attributes of the `guideme.ask` span, as they are known before the request is sent. */
interface AskSpanOptions {
  /** The alias or id being sent. */
  readonly model: string;
  /** Host of the base URL. */
  readonly host: string;
  /** Port of the base URL. */
  readonly port: number;
  /** How many questions this request carries. */
  readonly questions: number;
  /** Byte length of the state JSON. Always recorded. */
  readonly stateBytes: number;
  /** The state JSON, only when `recordState` was set. State is user data. */
  readonly state?: string | undefined;
}

/** One span per `Guide.ask`, shaped by the OpenTelemetry GenAI conventions. */
export const askSpan = (o: AskSpanOptions): AskSpan => {
  const span = tracer.startSpan("guideme.ask", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.provider.name": "typesafe",
      "gen_ai.operation.name": "ask",
      "gen_ai.request.model": o.model,
      "server.address": o.host,
      "server.port": int(o.port),
      "guideme.questions": int(o.questions),
      "guideme.state.bytes": int(o.stateBytes),
      ...(o.state === undefined ? {} : { "guideme.state": o.state }),
    },
  });
  return {
    span,
    response: (model, inputTokens, outputTokens) => {
      span.setAttribute("gen_ai.response.model", model);
      span.setAttribute("gen_ai.usage.input_tokens", int(inputTokens));
      span.setAttribute("gen_ai.usage.output_tokens", int(outputTokens));
    },
    end: () => {
      span.end();
    },
  };
};

/**
 * Mark a span failed: `error.type` plus the OpenTelemetry error status. `errorType` is an
 * {@link ErrorKind} on the ask span and on a 200 whose body failed, and the status code as
 * text on any other non-200, which is why it is spelled `string` rather than the union.
 */
export const failSpan = (handle: SpanHandle, errorType: string, description: string): void => {
  handle.span.setAttribute("error.type", errorType);
  handle.span.setStatus({ code: SpanStatusCode.ERROR, message: description });
};

/**
 * What a `guideme.retry` event carries. The contract says **exactly one** of
 * `http.response.status_code` and `error.type` is present on every retry event, so the type
 * is a union rather than two optional fields: a caller cannot construct an event with both or
 * with neither, and the rule is checked by the compiler instead of by review.
 */
type RetryEvent = ({ readonly status: number } | { readonly errorType: "transport" }) & {
  /** Ordinal of the resend about to be made; `1` for the first retry. */
  readonly attempt: number;
  /** How long guideme is about to wait, in milliseconds. */
  readonly delayMs: number;
};

/** The `guideme.retry` event, added to the failed attempt's span just before the wait. */
export const retryEvent = (handle: SpanHandle, e: RetryEvent): void => {
  handle.span.addEvent("guideme.retry", {
    ...("status" in e
      ? { "http.response.status_code": int(e.status) }
      : { "error.type": e.errorType }),
    "guideme.retry.attempt": int(e.attempt),
    "guideme.retry.delay_ms": int(e.delayMs),
  });
};

/**
 * The `guideme.answer` event, one per question. Emitted from the resolved outcome, before the
 * unsure ladder runs, so it says what the model answered rather than what the caller ended up
 * with.
 */
export const answerEvent = (
  handle: SpanHandle,
  id: string,
  outcome: Outcome,
  t: Thresholds,
): void => {
  const shared: Attributes = {
    "guideme.question": id,
    "guideme.yes_above": t.yesAbove,
    "guideme.no_below": t.noBelow,
    "guideme.min_confidence": t.minConfidence,
  };
  handle.span.addEvent("guideme.answer", { ...shared, ...answerAttributes(outcome) });
};

/** The per-kind half of a `guideme.answer` event. */
const answerAttributes = (outcome: Outcome): Attributes => {
  switch (outcome.kind) {
    case "noul":
      return {
        "guideme.kind": "noul",
        "guideme.outcome": outcome.verdict,
        "guideme.probability": outcome.p,
        "guideme.unsure": outcome.verdict === "unsure",
      };
    case "choice":
      return {
        "guideme.kind": "choice",
        "guideme.outcome": outcome.key,
        "guideme.confidence": outcome.confidence,
        "guideme.unsure": outcome.unsure,
      };
    case "score":
      return {
        "guideme.kind": "score",
        "guideme.outcome": int(outcome.index),
        "guideme.value": outcome.value,
        "guideme.confidence": outcome.confidence,
        "guideme.unsure": outcome.unsure,
      };
    default:
      return assertNever(outcome);
  }
};

/**
 * Which kinds carry a verbatim response body on their message.
 *
 * A `Record` over {@link ErrorKind} rather than a `switch`: a new kind is a compile error at
 * this declaration, which is where the question "does this one carry a body?" has to be
 * answered, rather than at a `default` arm further away.
 */
const CARRIES_A_BODY: Readonly<Record<ErrorKind, boolean>> = {
  auth: false,
  invalid: true,
  rate_limited: false,
  overloaded: false,
  transport: false,
  unexpected_status: true,
  protocol: false,
  unsure: false,
  config: false,
};

/**
 * The status description for a failed ask span. Ported from Rust's `describe()`: two kinds
 * carry a verbatim response body, which could echo the caller's state, so the span says only
 * which status it was and the body stays on the returned error.
 */
const describe = (e: GuidemeError): string => {
  if (!CARRIES_A_BODY[e.kind]) return e.message;
  return e.kind === "invalid"
    ? "invalid request: the 422 body is on the returned error"
    : `unexpected status ${String(e.status ?? 0)}: the body is on the returned error`;
};

/** Mark the ask span failed, with a description that never carries a response body. */
export const failAskSpan = (handle: SpanHandle, error: unknown): void => {
  const e = error instanceof GuidemeError ? error : undefined;
  handle.span.setAttribute("error.type", e?.kind ?? "transport");
  handle.span.setStatus({
    code: SpanStatusCode.ERROR,
    message: e === undefined ? "unknown failure" : describe(e),
  });
};
