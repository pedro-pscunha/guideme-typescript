import { GuidemeError, configError, protocolError, transportError } from "../errors.js";
import { parseModels, parseRequest, parseResponse } from "./wire.js";
import type { WireModelInfo, WireRequest, WireResponse } from "./wire.js";
import type { ApiKey } from "../scalars.js";
import { failSpan, httpSpan, retryEvent } from "../telemetry.js";
import type { HttpSpan } from "../telemetry.js";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_BACKOFF_MS = 500;
const JITTER_MS = 250;
const DEFAULT_MAX_RETRIES = 3;

/** How to reach the API. */
interface ClientOptions {
  /** The API key. Never printed. */
  readonly apiKey: ApiKey;
  /** The API origin; trailing slashes are stripped. Must carry no credentials. */
  readonly baseUrl?: string;
  /** Retries for 429, 529 and a failure to connect. Default 3; `0` disables retrying. */
  readonly maxRetries?: number;
  /** Base delay for exponential backoff, in milliseconds. Default 500. */
  readonly backoff?: number;
  /** Deadline per attempt, in milliseconds. Default 30 000. */
  readonly timeout?: number;
  /** Send through this `fetch` instead of the global one. */
  readonly fetch?: typeof globalThis.fetch;
}

/** 0 through 250 inclusive, from the platform CSPRNG. */
const jitter = (): number => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] ?? 0) % (JITTER_MS + 1);
};

/** Integer seconds only. A missing, non-integer or date-format header is `undefined`. */
const parseRetryAfter = (headers: Headers): number | undefined => {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
};

/** Sleep, so the retry loop reads as one sequence rather than as a callback. */
const wait = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** 401, 422 and every other undefined status, including a 3xx this client did not follow. */
const classify = (status: number, body: string): GuidemeError => {
  if (status === 401) {
    return new GuidemeError("auth", "unauthorized: missing or invalid TypeSafe API key");
  }
  if (status === 422) {
    return new GuidemeError("invalid", `invalid request: ${body}`, { body });
  }
  return new GuidemeError("unexpected_status", `unexpected status ${String(status)}: ${body}`, {
    status,
    body,
  });
};

/** 429 and 529, once the budget is gone or the wait the API asked for is too long. */
const throttled = (status: number, retryAfterMs: number | undefined): GuidemeError => {
  // Spread rather than passed straight through: `exactOptionalPropertyTypes` distinguishes an
  // absent `retry-after` from one explicitly set to `undefined`, and the API sending no header
  // is the absent case.
  const carried = retryAfterMs === undefined ? {} : { retryAfterMs };
  return status === 429
    ? new GuidemeError(
        "rate_limited",
        `rate limited (retry-after: ${String(retryAfterMs)})`,
        carried,
      )
    : new GuidemeError(
        "overloaded",
        `TypeSafe is overloaded (retry-after: ${String(retryAfterMs)})`,
        carried,
      );
};

/** One request, with everything the retry loop needs to make it again. */
interface Attempt<T> {
  readonly apiKey: ApiKey;
  readonly url: string;
  readonly template: "/v1/systemone" | "/v1/models";
  readonly method: "POST" | "GET";
  readonly body: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly maxRetries: number;
  readonly backoff: number;
  readonly timeout: number;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly parse: (v: unknown) => T;
}

/** Read and narrow a 200 body. A read failure is transport; a bad shape is protocol. */
const readBody = async <T>(opts: Attempt<T>, response: Response): Promise<T> => {
  let text: string;
  try {
    text = await response.text();
  } catch (e) {
    // The BODY phase. Never retried, whatever class it is.
    throw transportError("response body could not be read", e);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw protocolError(`response body is not JSON: ${String(e)}`);
  }
  return opts.parse(json);
};

/** Exponential backoff for this attempt, capped, plus jitter. */
const backoffFor = (opts: Attempt<unknown>, attempt: number): number =>
  Math.min(opts.backoff * 2 ** attempt, MAX_BACKOFF_MS) + jitter();

/** The request, built the same way on every attempt. */
const initFor = (opts: Attempt<unknown>): RequestInit => ({
  method: opts.method,
  headers: {
    authorization: `Bearer ${opts.apiKey.expose()}`,
    ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(opts.body === undefined ? {} : { body: opts.body }),
  signal: AbortSignal.timeout(opts.timeout),
  // Never follow a redirect: the Authorization header would travel with it, and whether it
  // survives a cross-origin hop is the runtime's decision, not ours.
  redirect: "manual",
});

/**
 * The connection phase failed. Wait and let the caller resend, or throw.
 *
 * A `TypeError` here is a refused or reset connection, or a TLS handshake failure: the request
 * went nowhere, so it is retried in the same budget. A `TimeoutError` or `AbortError` is this
 * client's own per-attempt deadline and is never retried. Measured: a body failure ALSO
 * surfaces as a `TypeError`, which is why the body read has its own `try` and never reaches
 * this branch.
 */
const afterConnectionFailure = async (
  opts: Attempt<unknown>,
  span: HttpSpan,
  e: unknown,
  attempt: number,
  last: boolean,
): Promise<void> => {
  const reachedNobody = e instanceof TypeError;
  const err = transportError(reachedNobody ? "could not reach TypeSafe" : "request failed", e);
  failSpan(span, err.kind, err.message);
  if (last || !reachedNobody) {
    span.end();
    throw err;
  }
  const delay = backoffFor(opts, attempt);
  retryEvent(span, { errorType: "transport", attempt: attempt + 1, delayMs: delay });
  span.end();
  await wait(delay);
};

/** A 200 arrived. Read and narrow it, or mark the attempt and throw. */
const afterSuccess = async <T>(
  opts: Attempt<T>,
  span: HttpSpan,
  response: Response,
): Promise<T> => {
  try {
    const value = await readBody(opts, response);
    span.end();
    return value;
  } catch (e) {
    const err = e instanceof GuidemeError ? e : protocolError(String(e));
    failSpan(span, err.kind, err.message);
    span.end();
    throw err;
  }
};

/** A non-200 arrived. Wait and let the caller resend, or throw the typed error. */
const afterStatus = async (
  opts: Attempt<unknown>,
  span: HttpSpan,
  response: Response,
  attempt: number,
  last: boolean,
): Promise<void> => {
  failSpan(span, String(response.status), `HTTP ${String(response.status)}`);
  if (response.status !== 429 && response.status !== 529) {
    const body = await response.text().catch(() => "");
    span.end();
    throw classify(response.status, body);
  }
  const retryAfterMs = parseRetryAfter(response.headers);
  if (last || (retryAfterMs !== undefined && retryAfterMs > MAX_BACKOFF_MS)) {
    span.end();
    throw throttled(response.status, retryAfterMs);
  }
  const delay = retryAfterMs ?? backoffFor(opts, attempt);
  retryEvent(span, { status: response.status, attempt: attempt + 1, delayMs: delay });
  span.end();
  await wait(delay);
};

/**
 * The 0.2.0 retry policy, once, for both endpoints.
 *
 * Classification is by **phase**, never by error class: the `fetch` call and the body read sit
 * in separate `try` blocks, and only the connection phase resends. Each phase's handler either
 * throws the typed error or returns once it has waited, so the loop itself is the budget and
 * nothing else.
 */
const send = async <T>(opts: Attempt<T>): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt === opts.maxRetries;
    const span = httpSpan({
      name: `${opts.method} ${opts.template}`,
      method: opts.method,
      host: opts.host,
      port: opts.port,
      url: opts.url,
      template: opts.template,
      resendCount: attempt > 0 ? attempt : undefined,
    });

    let response: Response;
    try {
      response = await opts.fetchImpl(opts.url, initFor(opts));
    } catch (e) {
      await afterConnectionFailure(opts, span, e, attempt, last);
      continue;
    }

    span.status(response.status);
    if (response.status === 200) return await afterSuccess(opts, span, response);
    await afterStatus(opts, span, response, attempt, last);
  }
};

/** A client for the TypeSafe HTTP API. Cheap to copy; holds no per-call state. */
export interface Client {
  /** `POST /v1/systemone`. */
  evaluate(request: WireRequest): Promise<WireResponse>;
  /** `GET /v1/models`. Retried on the same statuses, in the same budget. */
  models(): Promise<readonly WireModelInfo[]>;
  /** The host and port every request goes to, for the span attributes. */
  readonly server: { readonly host: string; readonly port: number };
}

/** The port the URL names, or the scheme's default; `0` when neither answers. */
const portOf = (parsed: URL): number => {
  if (parsed.port !== "") return Number.parseInt(parsed.port, 10);
  if (parsed.protocol === "https:") return 443;
  if (parsed.protocol === "http:") return 80;
  return 0;
};

/**
 * Build a client. The base URL must parse, must have a host and a port, and must carry no
 * credentials: it is recorded on every request span as `url.full`.
 */
export const createClient = (options: ClientOptions): Client => {
  const raw = options.baseUrl ?? DEFAULT_BASE_URL;
  const trimmed = raw.replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // `new URL` throws a plain TypeError, which is the class the retry loop resends on. It is
    // caught HERE, once, at construction, so a typo in baseUrl can never reach an attempt and
    // be retried three times before being reported as a transport failure.
    throw configError(`base_url ${JSON.stringify(trimmed)} is not a URL`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw configError("base_url must not carry credentials; use the api_key");
  }
  if (parsed.hostname === "") {
    throw configError(`base_url ${JSON.stringify(trimmed)} needs a host and a port`);
  }
  const port = portOf(parsed);
  if (port === 0) {
    throw configError(`base_url ${JSON.stringify(trimmed)} needs a host and a port`);
  }

  const shared = {
    apiKey: options.apiKey,
    host: parsed.hostname,
    port,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    backoff: options.backoff ?? DEFAULT_BACKOFF_MS,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetch ?? globalThis.fetch.bind(globalThis),
  } as const;

  return Object.freeze({
    server: Object.freeze({ host: parsed.hostname, port }),
    evaluate: async (request: WireRequest): Promise<WireResponse> =>
      send({
        ...shared,
        url: `${trimmed}/v1/systemone`,
        template: "/v1/systemone",
        method: "POST",
        // Validated before it is sent: SC5 covers the request schema as well.
        body: JSON.stringify(parseRequest(request)),
        parse: parseResponse,
      }),
    models: async (): Promise<readonly WireModelInfo[]> =>
      send({
        ...shared,
        url: `${trimmed}/v1/models`,
        template: "/v1/models",
        method: "GET",
        body: undefined,
        parse: parseModels,
      }),
  });
};
