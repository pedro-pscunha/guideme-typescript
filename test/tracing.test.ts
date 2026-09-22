import { beforeEach, expect, test } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { startServer, closedPort } from "./support/server.js";
import { useAsyncContext } from "./support/context.js";
import {
  ApiKey,
  Guide,
  GuidemeError,
  choice,
  choose,
  levels,
  noul,
  option,
  score,
} from "../src/index.js";
import { NOUL_AS_Q0 } from "./support/fixtures.js";

const exporter = new InMemorySpanExporter();

// A context manager, which `BasicTracerProvider` does not install and an application's
// `NodeSDK` does. Without one, `context.active()` is always the root and the HTTP attempt
// spans are roots too; `docs/observability.md` records that this is what carries the parenting.
useAsyncContext();

// A fresh provider per case, which means `trace.disable()` first: the API refuses a second
// registration while one is standing. Resetting the exporter alone would isolate the cases
// just as well, so the reason for doing it the hard way is the `disable()`. It throws away the
// `ProxyTracerProvider` every previously handed-out `ProxyTracer` is bound to, which is the
// same position `src/telemetry.ts` is in when an application resolves its own copy of
// `@opentelemetry/api` — the copy whose `register()` never touches this one's proxy. A tracer
// cached at import time would be a no-op from the second case onward and every assertion below
// would fail; resolving it per span, as `telemetry.ts` does, is what keeps them passing. That
// makes this setup the regression guard for a failure that is otherwise invisible until an
// application with two copies of the API gets no telemetry at all.
beforeEach(() => {
  exporter.reset();
  trace.disable();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

const spansNamed = (name: string): readonly ReadableSpan[] =>
  exporter.getFinishedSpans().filter((s) => s.name === name);

/**
 * A span's exported shape, as JSON. Never `JSON.stringify` a `ReadableSpan`: it holds its
 * span processor, which holds the exporter, which holds the span — a cycle `JSON.stringify`
 * throws on. These four fields are the whole population a secret could hide in.
 */
const serialiseSpans = (spans: readonly ReadableSpan[]): string =>
  JSON.stringify(
    spans.map((s) => ({
      name: s.name,
      attributes: s.attributes,
      status: s.status,
      events: s.events,
    })),
  );

test("one guideme.ask span carries exactly the documented attributes", async () => {
  const server = await startServer([{ status: 200, body: NOUL_AS_Q0 }]);
  const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl });
  await guide.ask(noul("Urgent?"), "hello");
  expect(spansNamed("guideme.ask"), "one guideme.ask span per Guide.ask").toHaveLength(1);
  const [ask] = spansNamed("guideme.ask");
  expect(ask?.kind).toBe(SpanKind.CLIENT);
  expect(ask?.instrumentationScope.name).toBe("guideme");
  expect(Object.keys(ask?.attributes ?? {}).sort()).toEqual([
    "gen_ai.operation.name",
    "gen_ai.provider.name",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "guideme.questions",
    "guideme.state.bytes",
    "server.address",
    "server.port",
  ]);
  expect(ask?.attributes["gen_ai.provider.name"]).toBe("typesafe");
  expect(ask?.attributes["gen_ai.operation.name"]).toBe("ask");
  expect(ask?.attributes["gen_ai.request.model"]).toBe("jev-latest");
  expect(ask?.attributes["gen_ai.response.model"]).toBe("jev-1.13.0");
  expect(ask?.attributes["gen_ai.usage.input_tokens"]).toBe(307);
  expect(ask?.attributes["gen_ai.usage.output_tokens"]).toBe(20);
  expect(ask?.attributes["guideme.questions"]).toBe(1);
  expect(ask?.attributes["guideme.state.bytes"]).toBe(
    new TextEncoder().encode(JSON.stringify("hello")).byteLength,
  );
});

test("one HTTP child span per attempt, with resend_count from the second", async () => {
  const server = await startServer([
    { status: 529, body: "" },
    { status: 200, body: NOUL_AS_Q0 },
  ]);
  const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl, backoff: 10 });
  await guide.ask(noul("Urgent?"), "x");
  const attempts = spansNamed("POST /v1/systemone");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.attributes["http.request.resend_count"]).toBeUndefined();
  expect(attempts[1]?.attributes["http.request.resend_count"]).toBe(1);
  expect(attempts[0]?.attributes["url.template"]).toBe("/v1/systemone");
  expect(attempts[0]?.attributes["http.request.method"]).toBe("POST");
  expect(attempts[0]?.status.code).toBe(SpanStatusCode.ERROR);
  expect(attempts[1]?.status.code).not.toBe(SpanStatusCode.ERROR);
  // Both are children of the one ask span.
  const [ask] = spansNamed("guideme.ask");
  for (const a of attempts) expect(a.parentSpanContext?.spanId).toBe(ask?.spanContext().spanId);
});

test.each([
  {
    kind: "noul",
    extra: ["guideme.probability"],
    missing: ["guideme.confidence", "guideme.value"],
  },
  {
    kind: "choice",
    extra: ["guideme.confidence"],
    missing: ["guideme.probability", "guideme.value"],
  },
  {
    kind: "score",
    extra: ["guideme.confidence", "guideme.value"],
    missing: ["guideme.probability"],
  },
] as const)("one guideme.answer event per $kind question", async ({ kind, extra, missing }) => {
  const Department = choice({ billing: option("b"), technical: option("t") });
  const Frustration = levels({ calm: "Calm", frustrated: "Frustrated" });
  const bodies = {
    noul: { type: "noul", noul: 0.92 },
    choice: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.95,
    },
    score: {
      type: "score",
      score: 0.9,
      legend: { "0": "Calm", "1": "Frustrated" },
      probabilities: { "0": 0.1, "1": 0.9 },
      confidence: 0.88,
    },
  } as const;
  const questions = {
    noul: () => noul("urgent?"),
    choice: () => choose(Department, "which team?"),
    score: () => score(Frustration, "how cross?"),
  } as const;

  const server = await startServer([
    {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13.0",
        answers: { q0: bodies[kind] },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  ]);
  const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl });
  await guide.ask(questions[kind](), "x");

  const [ask] = spansNamed("guideme.ask");
  const events = (ask?.events ?? []).filter((e) => e.name === "guideme.answer");
  expect(events).toHaveLength(1);
  const attrs: Attributes = events[0]?.attributes ?? {};

  // The five every kind carries, plus this kind's own, and nothing else.
  const shared = [
    "guideme.question",
    "guideme.kind",
    "guideme.outcome",
    "guideme.unsure",
    "guideme.yes_above",
    "guideme.no_below",
    "guideme.min_confidence",
  ];
  expect(Object.keys(attrs).sort()).toEqual([...shared, ...extra].sort());
  for (const absent of missing) expect(attrs[absent]).toBeUndefined();

  expect(attrs["guideme.question"]).toBe("q0");
  expect(attrs["guideme.kind"]).toBe(kind);
  expect(attrs["guideme.yes_above"]).toBe(0.5);
  expect(attrs["guideme.no_below"]).toBe(0.5);
  expect(attrs["guideme.min_confidence"]).toBe(0);
  expect(attrs["guideme.unsure"]).toBe(false);
  if (kind === "noul") expect(attrs["guideme.outcome"]).toBe("yes");
  if (kind === "choice") expect(attrs["guideme.outcome"]).toBe("billing");
  if (kind === "score") {
    // The level index, as an integer, not the level's name.
    expect(attrs["guideme.outcome"]).toBe(1);
    expect(attrs["guideme.value"]).toBe(0.9);
  }
});

test("a failure marks the ask span and never emits an ERROR log", async () => {
  const server = await startServer([{ status: 401, body: "" }]);
  const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl });
  await expect(guide.ask(noul("Urgent?"), "x")).rejects.toMatchObject({ kind: "auth" });
  const [ask] = spansNamed("guideme.ask");
  expect(ask?.attributes["error.type"]).toBe("auth");
  expect(ask?.status.code).toBe(SpanStatusCode.ERROR);
  expect(ask?.status.message).toContain("unauthorized");
  // guideme never emits an ERROR event; a failure is the span's status and nothing else.
  expect(ask?.events.map((e) => e.name)).not.toContain("guideme.error");

  // The 422 body could echo the caller's state, so it goes on the returned error and NOT on
  // the span's status description. This is Rust's `describe()` and it is the reason that
  // function exists at all.
  exporter.reset();
  const secret = "the customer's account number is 4111111111111111";
  const invalid = await startServer([{ status: 422, body: `{"error":{"message":"${secret}"}}` }]);
  const strict = new Guide({ apiKey: new ApiKey("k"), baseUrl: invalid.baseUrl });
  // Caught and narrowed rather than matched with a cast: `body` is what this half is about.
  const thrown: unknown = await strict.ask(noul("Urgent?"), "x").catch((e: unknown) => e);
  if (!(thrown instanceof GuidemeError)) throw new Error("expected a GuidemeError");
  expect(thrown.kind).toBe("invalid");
  expect(thrown.body).toContain(secret);
  const [failed] = spansNamed("guideme.ask");
  expect(failed?.attributes["error.type"]).toBe("invalid");
  expect(failed?.status.message).toBe("invalid request: the 422 body is on the returned error");
  expect(serialiseSpans(exporter.getFinishedSpans())).not.toContain(secret);
});

test("state is user data: bytes always, content only when asked for", async () => {
  // Non-ASCII on purpose: `.length` would report UTF-16 code units and the field says bytes.
  const body = { note: "un café très cher — 🧾" };
  const server = await startServer([{ status: 200, body: NOUL_AS_Q0 }]);
  const quiet = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl });
  await quiet.ask(noul("Urgent?"), body);
  let [ask] = spansNamed("guideme.ask");
  expect(ask?.attributes["guideme.state"]).toBeUndefined();
  const json = JSON.stringify(body);
  expect(ask?.attributes["guideme.state.bytes"]).toBe(new TextEncoder().encode(json).byteLength);
  // And the two genuinely differ on this value, which is what the assertion is for.
  expect(new TextEncoder().encode(json).byteLength).not.toBe(json.length);

  exporter.reset();
  const loud = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl, recordState: true });
  await loud.ask(noul("Urgent?"), body);
  [ask] = spansNamed("guideme.ask");
  expect(ask?.attributes["guideme.state"]).toBe(JSON.stringify(body));
});

test.each([
  { name: "429", status: 429 },
  { name: "529", status: 529 },
  { name: "refused connection", status: undefined },
] as const)(
  "a $name retry event carries exactly one of a status and an error.type",
  async ({ status }) => {
    // A status row answers once with that status and then succeeds; the refused row points at a
    // port nothing listens on, so its one retry is a transport failure and the ask then fails.
    const baseUrl =
      status === undefined
        ? `http://127.0.0.1:${String(await closedPort())}`
        : (
            await startServer([
              { status, body: "" },
              { status: 200, body: NOUL_AS_Q0 },
            ])
          ).baseUrl;
    const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl, maxRetries: 1, backoff: 10 });
    const settled = await guide.ask(noul("Urgent?"), "x").then(
      () => "answered",
      (e: unknown) => (e instanceof GuidemeError ? e.kind : "not a GuidemeError"),
    );
    expect(settled, "a status is retried to success; a refused connection ends as transport").toBe(
      status === undefined ? "transport" : "answered",
    );

    const retries = exporter
      .getFinishedSpans()
      .flatMap((s) => s.events)
      .filter((e) => e.name === "guideme.retry");
    expect(retries, "one guideme.retry event before each wait").toHaveLength(1);
    const attrs = retries[0]?.attributes ?? {};
    expect(
      attrs["http.response.status_code"],
      "a retry after a response carries its status, and one after no response carries none",
    ).toBe(status);
    expect(
      attrs["error.type"],
      "error.type is present exactly when http.response.status_code is not",
    ).toBe(status === undefined ? "transport" : undefined);
    expect(attrs["guideme.retry.attempt"], "the first retry is attempt 1").toBe(1);
    expect(typeof attrs["guideme.retry.delay_ms"], "the wait is recorded in milliseconds").toBe(
      "number",
    );
  },
);
