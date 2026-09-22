import { expect, test, vi } from "vitest";
import noulFixture from "./fixtures/noul.json" with { type: "json" };
import choiceFixture from "./fixtures/choice.json" with { type: "json" };
import scoreFixture from "./fixtures/score.json" with { type: "json" };
import { parseModels, parseRequest, parseResponse, schemaShapes } from "../src/api/wire.js";
import modelsFixture from "./fixtures/models.json" with { type: "json" };
import requestJson from "../spec/schema/request.json" with { type: "json" };
import responseJson from "../spec/schema/response.json" with { type: "json" };
import { closedPort, startServer } from "./support/server.js";
import { BAD_NOUL_AS_Q0, NOUL_AS_Q0 } from "./support/fixtures.js";
import { ApiKey, Guide, choice, choose, levels, noul, option, score } from "../src/index.js";
import type { ChoiceDescriptor } from "../src/index.js";
import { createClient } from "../src/api/client.js";
import type { Client } from "../src/api/client.js";
import { model } from "../src/scalars.js";

/** A non-null object, viewed as the record its fields form. */
const isRecord = (v: unknown): v is Readonly<Record<string, { instructions?: unknown }>> =>
  typeof v === "object" && v !== null;

/** The `questions` map of a request body the test server received. Narrowed, never asserted. */
const questionsOf = (sent: unknown): Readonly<Record<string, { instructions?: unknown }>> => {
  if (!isRecord(sent) || !("questions" in sent)) return {};
  const questions: unknown = sent["questions"];
  return isRecord(questions) ? questions : {};
};

// The models docs fixture, parsed once. It has one row and no table of its own to live in.
const MODELS_PARSED = parseModels(modelsFixture);
expect(MODELS_PARSED, "the models docs fixture lists exactly jev-latest").toEqual([
  { name: "jev-latest", description: "The most recent stable release", release_date: "2026-08-01" },
]);

test.each([
  { name: "noul", body: noulFixture, inputTokens: 307 },
  { name: "choice", body: choiceFixture, inputTokens: 318 },
  { name: "score", body: scoreFixture, inputTokens: 304 },
])("the $name docs fixture parses and round-trips", ({ body, inputTokens }) => {
  const parsed = parseResponse(body);
  expect(JSON.parse(JSON.stringify(parsed)), "a docs response survives parsing unchanged").toEqual(
    body,
  );
  expect(parsed.model, "model is the versioned id the docs example carries").toBe("jev-1.13.0");
  expect(parsed.usage.input_tokens, "usage.input_tokens is read as the docs state it").toBe(
    inputTokens,
  );
});

/** Whether a JSON Schema, at any depth, states an array bound. Walked, not pattern-matched. */
const hasArrayBound = (schema: unknown): boolean => {
  if (Array.isArray(schema)) return schema.some(hasArrayBound);
  if (typeof schema !== "object" || schema === null) return false;
  if ("minItems" in schema || "maxItems" in schema) return true;
  return Object.values(schema).some(hasArrayBound);
};

test("probabilities are range-checked at parse time and unknown fields are ignored", () => {
  const bad = (noul: number): unknown => ({
    model: "jev-1.13.0",
    answers: { q0: { type: "noul", noul } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  for (const value of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => parseResponse(bad(value)), `a noul of ${String(value)} is outside 0..=1`).toThrow(
      expect.objectContaining({ kind: "protocol" }),
    );
  }
  // An integer `0` on the wire is a valid probability and must parse; a boolean must not.
  // `0` is a probability the API really sends, and a validator that rejected it because the
  // JSON literal is an integer would fail on a real response. A boolean is not a number and
  // must be refused. Measured on zod 4.6.5: `z.number().min(0).max(1)` accepts 0 and 1 and
  // rejects `true`, `NaN` and `Infinity`.
  expect(parseResponse(bad(0)).answers["q0"], "0 is a probability").toEqual({
    type: "noul",
    noul: 0,
  });
  expect(parseResponse(bad(1)).answers["q0"], "1 is a probability").toEqual({
    type: "noul",
    noul: 1,
  });
  expect(
    () =>
      parseResponse({
        model: "jev-1.13.0",
        answers: { q0: { type: "noul", noul: true } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    "a boolean is not a probability",
  ).toThrow(expect.objectContaining({ kind: "protocol" }));
  const withExtras = {
    model: "jev-1.13.0",
    answers: { q0: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 9 },
    trace_id: "abc",
  };
  const parsed = parseResponse(withExtras);
  expect(parsed, "fields the contract does not name are ignored, not kept and not refused").toEqual(
    {
      model: "jev-1.13.0",
      answers: { q0: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );

  // A model name the API sends is branded where it is parsed, and a blank one is the API's
  // mistake, so it is `protocol` — the same refusal a caller's blank model gets as `config`.
  expect(
    () =>
      parseResponse({
        model: " \t",
        answers: { q0: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    "a whitespace-only model from the API is a protocol error",
  ).toThrow(expect.objectContaining({ kind: "protocol" }));
  expect(
    () => parseModels({ models: [{ name: " ", description: "d", release_date: "2026-08-01" }] }),
    "a blank model name in the catalogue is a protocol error",
  ).toThrow(expect.objectContaining({ kind: "protocol" }));

  // SC5 says the REQUEST schema too, not only the response. A body this package builds and
  // cannot validate is its own mistake, so it is a `config` error.
  expect(
    () => parseRequest({ model: "", questions: {}, state: "x" }),
    "a request this package cannot validate is its own config error",
  ).toThrow(expect.objectContaining({ kind: "config" }));
  expect(
    parseRequest({
      state: "x",
      model: "jev-latest",
      questions: { q0: { type: "noul", instructions: "urgent?" } },
    }).model,
    "a valid request parses to itself",
  ).toBe("jev-latest");

  // And both schemas agree with the vendored spec/schema/*.json on what an object is and what
  // is required. zod 4 ships `z.toJSONSchema`, so this needs no second dependency; the drift
  // job covers the rest of the file and this covers the part the code actually enforces.
  const shapes = schemaShapes();
  const vendored: Readonly<Record<"request" | "response", unknown>> = {
    request: requestJson,
    response: responseJson,
  };
  interface JsonObjectSchema {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  }
  const asObjectSchema = (v: unknown): JsonObjectSchema =>
    typeof v === "object" && v !== null ? v : {};
  for (const which of ["request", "response"] as const) {
    const mine = asObjectSchema(shapes[which]);
    const theirs = asObjectSchema(vendored[which]);
    expect(
      [...(mine.required ?? [])].sort(),
      `the ${which} schema requires what spec/schema/${which}.json requires`,
    ).toEqual([...(theirs.required ?? [])].sort());
    expect(
      Object.keys(mine.properties ?? {}).sort(),
      `the ${which} schema names the properties spec/schema/${which}.json names`,
    ).toEqual(Object.keys(theirs.properties ?? {}).sort());
    // And no array bound anywhere. The score question's `criteria` is a bare string array in
    // the vendored schema; a `minItems` / `maxItems` here would be this package inventing a
    // bound the contract does not state. The 2..=10 level rule lives in `ScoreImpl.encode`,
    // which is where Rust enforces it too, and `test/rubric-rules.test.ts` reaches it.
    expect(hasArrayBound(theirs), `vendored ${which} states no array bound`).toBe(false);
    expect(hasArrayBound(mine), `emitted ${which} states no array bound`).toBe(false);
  }
});

// ---- the client and the 0.2.0 retry policy (cases 13-20) --------------------------------

const NOUL = JSON.stringify(noulFixture);
const MODELS = JSON.stringify(modelsFixture);
const request = {
  state: "Help! My payouts have been failing for 3 days.",
  model: "jev-latest",
  questions: { q0: { type: "noul" as const, instructions: "Does this convey urgency?" } },
};
const clientFor = (baseUrl: string, maxRetries = 3): Client =>
  createClient({ apiKey: new ApiKey("test-key"), baseUrl, maxRetries, backoff: 10 });

// Only the three cases below fan out over both endpoints: 401, 429 with `retry-after`, and a
// refused connection. `send()` is the one seam both endpoints share, so the rest of the policy
// is proven once, through `evaluate`, and holds for `models` by construction.
const both = [
  { endpoint: "POST /v1/systemone", call: (c: Client): Promise<unknown> => c.evaluate(request) },
  { endpoint: "GET /v1/models", call: (c: Client): Promise<unknown> => c.models() },
] as const;

test.each(both)("$endpoint: 401 is auth and is not retried", async ({ call }) => {
  const server = await startServer([{ status: 401, body: "" }]);
  await expect(call(clientFor(server.baseUrl))).rejects.toMatchObject({ kind: "auth" });
  expect(server.received).toHaveLength(1);
  expect(server.received[0]?.headers["authorization"]).toBe("Bearer test-key");
});

test("422 carries the body verbatim and is not retried", async () => {
  const body = '{"error":{"field":"questions.q0.criteria","message":"too many options"}}';
  const server = await startServer([{ status: 422, body }]);
  await expect(clientFor(server.baseUrl).evaluate(request)).rejects.toMatchObject({
    kind: "invalid",
    body,
  });
  expect(server.received).toHaveLength(1);
});

test.each(both)(
  "$endpoint: 429 with retry-after: 1 is retried after that delay",
  async ({ endpoint, call }) => {
    const isModels = endpoint === "GET /v1/models";
    const server = await startServer([
      { status: 429, headers: { "retry-after": "1" }, body: "" },
      { status: 200, body: isModels ? MODELS : NOUL },
    ]);
    const started = Date.now();
    const result = await call(clientFor(server.baseUrl));
    const waited = Date.now() - started;
    expect(waited, "retry-after: 1 is honoured as one second").toBeGreaterThanOrEqual(1000);
    expect(waited, "and not as the computed backoff on top of it, or a second wait").toBeLessThan(
      2000,
    );
    expect(server.received).toHaveLength(2);
    expect(result).toEqual(isModels ? MODELS_PARSED : parseResponse(noulFixture));
  },
);

test("a retry-after longer than the cap fails at once and carries the value", async () => {
  const server = await startServer([{ status: 429, headers: { "retry-after": "3600" }, body: "" }]);
  await expect(
    clientFor(server.baseUrl).evaluate(request),
    "a wait over the 30 s cap is not taken; the error carries it for the caller",
  ).rejects.toMatchObject({
    kind: "rate_limited",
    retryAfterMs: 3_600_000,
  });
  expect(server.received, "a wait that is not taken is not followed by a resend").toHaveLength(1);

  // Integer seconds only. Rust parses the header with `u64::from_str`, which refuses anything
  // that is not entirely digits, so `3.5` and `1abc` are the ABSENT case there and must be
  // here: the computed backoff applies and the request is retried. `Number.parseInt` would
  // have read them as 3 and 1 and waited, which is a different wait in two SDKs. A
  // date-format `retry-after` starts with a digit too, and is absent for the same reason.
  for (const header of ["3.5", "1abc", "Wed, 21 Oct 2026 07:28:00 GMT", " "]) {
    const loose = await startServer([
      { status: 429, headers: { "retry-after": header }, body: "" },
      { status: 200, body: NOUL },
    ]);
    const started = Date.now();
    await clientFor(loose.baseUrl).evaluate(request);
    // The computed backoff at attempt 0 is 10 ms plus jitter, nowhere near the 1 s or 3.5 s a
    // parsed header would have asked for.
    expect(Date.now() - started, `retry-after: ${header} must not be honoured`).toBeLessThan(1000);
    expect(loose.received, `retry-after: ${header} is absent, so 429 is retried`).toHaveLength(2);
  }
});

test("529 exhausts the budget, then carries the retry-after it last saw", async () => {
  const server = await startServer([{ status: 529, headers: { "retry-after": "2" }, body: "" }]);
  await expect(clientFor(server.baseUrl, 2).evaluate(request)).rejects.toMatchObject({
    kind: "overloaded",
    retryAfterMs: 2000,
  });
  expect(server.received).toHaveLength(3); // maxRetries + 1
});

test.each(both)(
  "$endpoint: a refused connection is retried, then is transport",
  async ({ call }) => {
    const port = await closedPort();
    const attempts = vi.fn<typeof globalThis.fetch>(globalThis.fetch);
    const spied = createClient({
      apiKey: new ApiKey("test-key"),
      baseUrl: `http://127.0.0.1:${String(port)}`,
      maxRetries: 2,
      backoff: 10,
      fetch: attempts,
    });
    await expect(call(spied)).rejects.toMatchObject({ kind: "transport" });
    expect(attempts).toHaveBeenCalledTimes(3); // maxRetries + 1, in the same budget
  },
);

test("a timeout is NOT retried: one attempt, then transport", async () => {
  const server = await startServer([{ hang: true }]);
  const attempts = vi.fn<typeof globalThis.fetch>(globalThis.fetch);
  const client = createClient({
    apiKey: new ApiKey("test-key"),
    baseUrl: server.baseUrl,
    maxRetries: 3,
    backoff: 10,
    timeout: 50,
    fetch: attempts,
  });
  await expect(client.evaluate(request)).rejects.toMatchObject({ kind: "transport" });
  expect(attempts).toHaveBeenCalledTimes(1);
  expect(server.received).toHaveLength(1);
});

test("a body that closes mid-stream is NOT retried", async () => {
  const server = await startServer([{ cutMidBody: true }]);
  await expect(clientFor(server.baseUrl, 3).evaluate(request)).rejects.toMatchObject({
    kind: "transport",
  });
  // The rejection is a TypeError, exactly like a refused connection. Only the phase tells
  // them apart, and the phase is why this served exactly one request.
  expect(server.received).toHaveLength(1);

  // And an error status whose body cannot be read keeps its status kind. The body is not
  // invented — no empty string standing in for a body that never arrived — and the read
  // failure travels as the cause.
  const unreadable = await startServer([{ cutMidBody: true, status: 422 }]);
  const thrown: unknown = await clientFor(unreadable.baseUrl, 3)
    .evaluate(request)
    .catch((e: unknown) => e);
  expect(thrown, "a 422 is invalid whether or not its body can be read").toMatchObject({
    kind: "invalid",
    body: undefined,
  });
  expect(
    thrown instanceof Error ? thrown.cause : undefined,
    "the body read failure is carried as the cause",
  ).toBeInstanceOf(Error);
  expect(unreadable.received, "a status error is never retried").toHaveLength(1);
});

// ---- shapes, the guide and the receipt (cases 21-25) -------------------------------------

test("a malformed body and an option outside the rubric are both protocol errors", async () => {
  const guideFor = (baseUrl: string): Guide =>
    new Guide({ apiKey: new ApiKey("k"), baseUrl, backoff: 10 });

  const malformed = await startServer([{ status: 200, body: BAD_NOUL_AS_Q0 }]);
  await expect(
    guideFor(malformed.baseUrl).ask(noul("Urgent?"), "x"),
    "a body that breaks the response schema is a protocol error",
  ).rejects.toMatchObject({ kind: "protocol" });

  const ghost = await startServer([
    {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          q0: {
            type: "choice",
            choice: "ghost",
            probabilities: { ghost: 1, billing: 0 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  ]);
  const Two = choice({ billing: option("b"), technical: option("t") });
  await expect(
    guideFor(ghost.baseUrl).ask(choose(Two, "Which?"), "x"),
    "an option the rubric does not contain is a protocol error, never a default",
  ).rejects.toMatchObject({ kind: "protocol" });

  // A redirect is not followed: the Authorization header would travel with it. The status
  // falls through to `unexpected_status` and the host the `location` names sees nothing.
  const elsewhere = await startServer([{ status: 200, body: NOUL_AS_Q0 }]);
  const redirecting = await startServer([
    { status: 302, headers: { location: `${elsewhere.baseUrl}/v1/systemone` }, body: "" },
  ]);
  await expect(
    guideFor(redirecting.baseUrl).ask(noul("Urgent?"), "x"),
    "a redirect surfaces as unexpected_status and is not followed",
  ).rejects.toMatchObject({ kind: "unexpected_status", status: 302 });
  expect(elsewhere.received, "the redirect target never sees the request").toHaveLength(0);

  // A 200 whose body is not JSON is protocol, and the parser's own error stays as the cause.
  const notJson = await startServer([{ status: 200, body: "not json" }]);
  const thrown: unknown = await guideFor(notJson.baseUrl)
    .ask(noul("Urgent?"), "x")
    .catch((e: unknown) => e);
  expect(thrown, "a body that is not JSON is a protocol error").toMatchObject({
    kind: "protocol",
  });
  expect(
    thrown instanceof Error ? thrown.cause : undefined,
    "the JSON parser's error is carried as the cause",
  ).toBeInstanceOf(SyntaxError);
});

/** One named scenario of a table case, so a failure reports the scenario that broke. */
interface Scenario {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

/** A guide whose server answers every request with a noul of exactly 0.5. */
const halfGuide = async (): Promise<Guide> => {
  const server = await startServer([
    {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13.0",
        answers: { q0: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  ]);
  return new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl, backoff: 10 });
};

// A descriptor assembled by hand — which the type forbids, so only JavaScript can hand one in
// — is refused when its keys and rubrics disagree, not padded with `null`: `null` means
// "described not at all", and inventing that would put a bare key on the wire nobody wrote.
// Built through `unknown` because the brand is what makes it a type error.
type Descriptor = ChoiceDescriptor<string>;
const handBuilt = (keys: readonly string[], rubrics: readonly unknown[]): Descriptor =>
  ({ descriptor: "choice", keys, rubrics, fallbackKey: undefined }) as unknown as Descriptor;

const configAndUnsure: readonly Scenario[] = [
  {
    name: "unsure with no fallback names the question",
    run: async () => {
      const guide = await halfGuide();
      await expect(
        guide.ask(noul("Urgent?").yesAbove(0.9).noBelow(0.1), "x"),
      ).rejects.toMatchObject({
        kind: "unsure",
        question: "q0",
      });
    },
  },
  {
    name: "a fallback resolves an unsure answer instead of failing",
    run: async () => {
      const guide = await halfGuide();
      await expect(
        guide.ask(noul("Urgent?").yesAbove(0.9).noBelow(0.1).or(false), "x"),
      ).resolves.toBe(false);
    },
  },
  {
    name: "an empty batch, as an array or an object, is a config error",
    run: async () => {
      const guide = await halfGuide();
      await expect(guide.ask([], "x")).rejects.toMatchObject({ kind: "config" });
      await expect(guide.ask({}, "x")).rejects.toMatchObject({ kind: "config" });
    },
  },
  {
    name: "a retry budget, backoff or deadline that cannot mean what it says is refused",
    run: () => {
      // Refused at construction: a negative or fractional budget never reaches `last` and
      // loops on, and a non-positive deadline surfaced as a transport failure on the first ask.
      for (const bad of [
        { maxRetries: -1 },
        { maxRetries: 1.5 },
        { maxRetries: Number.NaN },
        { maxRetries: Number.POSITIVE_INFINITY },
        { backoff: -1 },
        { backoff: Number.NaN },
        { backoff: Number.POSITIVE_INFINITY },
        { timeout: 0 },
        { timeout: -5 },
        { timeout: Number.NaN },
        { timeout: Number.POSITIVE_INFINITY },
        // Node clamps a timer above 2^31-1 ms to 1 ms, so a larger deadline would fire at once.
        { timeout: 2 ** 31 },
      ]) {
        expect(
          () => new Guide({ apiKey: new ApiKey("k"), ...bad }),
          `${JSON.stringify(bad)} is refused when the guide is built`,
        ).toThrow(expect.objectContaining({ kind: "config" }));
      }
    },
  },
  {
    name: "zero retries, zero backoff and the largest timer deadline are legal",
    run: () => {
      expect(
        new Guide({ apiKey: new ApiKey("k"), maxRetries: 0, backoff: 0, timeout: 2 ** 31 - 1 }),
        "zero retries, zero backoff and the largest deadline a timer can hold are all legal",
      ).toBeInstanceOf(Guide);
    },
  },
  {
    name: "a hand-built descriptor with a key missing its rubric is a config error",
    run: async () => {
      const guide = await halfGuide();
      await expect(
        guide.ask(choose(handBuilt(["a", "b"], [option("a")]), "Which?"), "x"),
        "a key without its rubric is a config error",
      ).rejects.toMatchObject({ kind: "config" });
    },
  },
  {
    name: "a hand-built descriptor with a repeated key is a config error",
    run: async () => {
      const guide = await halfGuide();
      await expect(
        guide.ask(choose(handBuilt(["a", "a"], [option("a"), option("b")]), "Which?"), "x"),
        "a key given twice is a config error",
      ).rejects.toMatchObject({ kind: "config" });
    },
  },
  // State is whatever `JSON.stringify` makes of it, checked after `toJSON` has run.
  {
    name: "a value shared by two state fields is not a cycle",
    run: async () => {
      const guide = await halfGuide();
      const customer = { id: 7 };
      await expect(
        guide.ask(noul("Urgent?"), { a: customer, b: customer }),
        "a shared reference is not a cycle",
      ).resolves.toBe(true);
    },
  },
  {
    name: "a NaN that toJSON drops never reaches the JSON",
    run: async () => {
      const guide = await halfGuide();
      class Masked {
        readonly score = Number.NaN;
        toJSON(): unknown {
          return { masked: true };
        }
      }
      await expect(
        guide.ask(noul("Urgent?"), new Masked()),
        "a NaN that toJSON removes never reaches the JSON",
      ).resolves.toBe(true);
    },
  },
  {
    name: "a non-finite number, a bigint or a real cycle in state is refused",
    run: async () => {
      const guide = await halfGuide();
      const cyclic: Record<string, unknown> = {};
      cyclic["self"] = cyclic;
      for (const [what, state] of [
        ["a NaN", Number.NaN],
        ["an Infinity inside an object", { n: Number.POSITIVE_INFINITY }],
        ["a bigint", { n: 1n }],
        ["a real cycle", cyclic],
      ] as const) {
        await expect(guide.ask(noul("Urgent?"), state), `${what} is refused`).rejects.toMatchObject(
          { kind: "config" },
        );
      }
    },
  },
];

test.each(configAndUnsure)("config and unsure: $name", async ({ run }) => {
  await run();
});

test("askWithReceipt returns the response's model and usage exactly", async () => {
  const server = await startServer([{ status: 200, body: NOUL_AS_Q0 }]);
  const guide = new Guide({
    apiKey: new ApiKey("k"),
    baseUrl: server.baseUrl,
    model: model("jev-latest"),
  });
  const receipt = await guide.askWithReceipt(noul("Urgent?"), "x");
  expect(receipt.answer).toBe(true);
  expect(receipt.model).toBe("jev-1.13.0"); // the versioned id, not the alias that was sent
  expect(receipt.usage).toEqual({ inputTokens: 307, outputTokens: 20 });
  expect(Object.isFrozen(receipt.usage)).toBe(true);
  // The request carried the alias.
  expect(JSON.parse(server.received[0]?.body ?? "{}")).toMatchObject({ model: "jev-latest" });
});

// Five answers under q0..q4: the tuple below reads all five, a bare question reads only q0. The
// extra answers a smaller ask does not need are ignored, because the reply is walked by the
// plan's question ids rather than by what the body happens to carry.
const FIVE_ANSWERS = JSON.stringify({
  model: "jev-1.13.0",
  answers: {
    q0: { type: "noul", noul: 0.92 },
    q1: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.95,
    },
    q2: {
      type: "score",
      score: 1,
      legend: { "0": "Calm", "1": "Frustrated" },
      probabilities: { "0": 0.1, "1": 0.9 },
      confidence: 0.9,
    },
    q3: { type: "noul", noul: 0.1 },
    q4: { type: "noul", noul: 0.8 },
  },
  usage: { input_tokens: 11, output_tokens: 2 },
});

const shapesAndModels: readonly Scenario[] = [
  {
    name: "a tuple answers each member in place, with ids q0..qN in encounter order",
    run: async () => {
      const server = await startServer([{ status: 200, body: FIVE_ANSWERS }]);
      const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl });
      const Department = choice({ billing: option("b"), technical: option("t") });
      const Frustration = levels({ calm: "Calm", frustrated: "Frustrated" });
      const [urgent, dept, mood, flags] = await guide.ask(
        [
          noul("urgent?"),
          choose(Department, "which team?"),
          score(Frustration, "how cross?"),
          { spam: noul("spam?"), vip: noul("vip?") },
        ] as const,
        "a ticket",
      );
      expect(urgent, "a noul answers a boolean").toBe(true);
      expect(dept, "a choice answers its option key").toBe("billing");
      expect(mood, "a score answers its argmax level's key").toBe("frustrated");
      expect(flags, "an object shape answers an object of the same keys").toEqual({
        spam: false,
        vip: true,
      });
      // Depth first, and the object shape's two questions are the last two because they were
      // written last.
      const sent: unknown = JSON.parse(server.received[0]?.body ?? "{}");
      expect(Object.keys(questionsOf(sent)), "ids are q0..qN in encounter order").toEqual([
        "q0",
        "q1",
        "q2",
        "q3",
        "q4",
      ]);
    },
  },
  {
    name: "a bare question is its own answer",
    run: async () => {
      const server = await startServer([{ status: 200, body: FIVE_ANSWERS }]);
      const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl });
      await expect(
        guide.ask(noul("urgent?"), "x"),
        "a bare question is its own answer",
      ).resolves.toBe(true);
    },
  },
  {
    name: "models() copies the wire entry into this package's shape, snake to camel",
    run: async () => {
      const server = await startServer([{ status: 200, body: MODELS }]);
      const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl });
      const catalogue = await guide.models();
      expect(catalogue, "models() answers this package's shape, snake to camel").toEqual([
        {
          name: "jev-latest",
          description: "The most recent stable release",
          releaseDate: "2026-08-01",
        },
      ]);
      expect(Object.isFrozen(catalogue[0]), "a catalogue entry is frozen").toBe(true);
    },
  },
  {
    name: "an integer-like object key is encountered first, as JavaScript orders it",
    run: async () => {
      // JavaScript reorders integer-like keys ahead of string keys, so "1" is encountered
      // before "2" whatever the caller wrote. docs/contract.md records this as the TypeScript
      // spelling of the encounter-order rule; the assertion is here so it cannot change
      // unnoticed.
      const twoBody = JSON.stringify({
        model: "jev-1.13.0",
        answers: { q0: { type: "noul", noul: 0.9 }, q1: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const ordered = await startServer([{ status: 200, body: twoBody }]);
      const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: ordered.baseUrl });
      const answered = await guide.ask({ "2": noul("second"), "1": noul("first") }, "x");
      const ordering: unknown = JSON.parse(ordered.received[0]?.body ?? "{}");
      expect(
        questionsOf(ordering)["q0"]?.instructions,
        "an integer-like key is encountered first, as JavaScript orders it",
      ).toBe("first");
      expect(answered, "each answer comes back under the key it was asked by").toEqual({
        "1": true,
        "2": false,
      });
    },
  },
];

test.each(shapesAndModels)("shapes and models(): $name", async ({ run }) => {
  await run();
});

test("an injected fetch is the only transport, and the README recipe is this input", async () => {
  const realFetch = vi.spyOn(globalThis, "fetch");
  const answers = {
    q0: { type: "noul" as const, noul: 0.92 },
    q1: {
      type: "choice" as const,
      choice: "billing",
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.95,
    },
  };
  const calls: { url: string; authorization: string | null }[] = [];
  const fakeFetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  const Department = choice({ billing: option("b"), technical: option("t") });
  const guide = new Guide({ apiKey: new ApiKey("sk-test"), fetch: fakeFetch });
  const [urgent, dept] = await guide.ask(
    [noul("Is this urgent?"), choose(Department, "Which team?")] as const,
    "My card was charged twice",
  );
  expect(urgent).toBe(true);
  expect(dept).toBe("billing");
  expect(calls).toEqual([
    { url: "https://api.typesafe.ai/v1/systemone", authorization: "Bearer sk-test" },
  ]);
  expect(realFetch).not.toHaveBeenCalled();

  // A throttled response's body is released before the wait, so a retry never leaves the
  // previous attempt's stream open behind it.
  let released = false;
  const throttledThenOk: typeof globalThis.fetch = () => {
    if (!released) {
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          released = true;
        },
      });
      return Promise.resolve(new Response(body, { status: 429, headers: { "retry-after": "0" } }));
    }
    return Promise.resolve(new Response(NOUL_AS_Q0, { status: 200 }));
  };
  const patient = new Guide({ apiKey: new ApiKey("sk-test"), fetch: throttledThenOk });
  await expect(patient.ask(noul("Urgent?"), "x"), "the retry answers").resolves.toBe(true);
  expect(released, "the 429's body was cancelled before the retry").toBe(true);
});
