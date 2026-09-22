import { expect, test, vi } from "vitest";
import noulFixture from "./fixtures/noul.json" with { type: "json" };
import choiceFixture from "./fixtures/choice.json" with { type: "json" };
import scoreFixture from "./fixtures/score.json" with { type: "json" };
import { parseModels, parseRequest, parseResponse, schemaShapes } from "../src/api/wire.js";
import modelsFixture from "./fixtures/models.json" with { type: "json" };
import requestJson from "../spec/schema/request.json" with { type: "json" };
import responseJson from "../spec/schema/response.json" with { type: "json" };
import { closedPort, startServer } from "./support/server.js";
import { ApiKey, Guide, choice, choose, levels, noul, option, score } from "../src/index.js";
import { createClient } from "../src/api/client.js";
import type { Client } from "../src/api/client.js";
import { model } from "../src/scalars.js";
import noulQ0 from "./fixtures/noul-q0.json" with { type: "json" };
import badNoulFixture from "./fixtures/bad-noul-q0.json" with { type: "json" };

const NOUL_AS_Q0 = JSON.stringify(noulQ0);

/** A non-null object, viewed as the record its fields form. */
const isRecord = (v: unknown): v is Readonly<Record<string, { instructions?: unknown }>> =>
  typeof v === "object" && v !== null;

/** The `questions` map of a request body the test server received. Narrowed, never asserted. */
const questionsOf = (sent: unknown): Readonly<Record<string, { instructions?: unknown }>> => {
  if (!isRecord(sent) || !("questions" in sent)) return {};
  const questions: unknown = sent["questions"];
  return isRecord(questions) ? questions : {};
};

test.each([
  { name: "noul", body: noulFixture },
  { name: "choice", body: choiceFixture },
  { name: "score", body: scoreFixture },
])("the $name docs fixture parses and round-trips", ({ body }) => {
  const parsed = parseResponse(body);
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(body);
  expect(parsed.model).toBe("jev-1.13.0");
  expect(parsed.usage.input_tokens).toBeGreaterThan(0);
  const models = parseModels(modelsFixture);
  expect(models).toHaveLength(1);
  expect(models[0]?.name).toBe("jev-latest");
});

test("probabilities are range-checked at parse time and unknown fields are ignored", () => {
  const bad = (noul: number): unknown => ({
    model: "jev-1.13.0",
    answers: { q0: { type: "noul", noul } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  for (const value of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => parseResponse(bad(value))).toThrow(expect.objectContaining({ kind: "protocol" }));
  }
  // An integer `0` on the wire is a valid probability and must parse; a boolean must not.
  // `0` is a probability the API really sends, and a validator that rejected it because the
  // JSON literal is an integer would fail on a real response. A boolean is not a number and
  // must be refused. Measured on zod 4.6.5: `z.number().min(0).max(1)` accepts 0 and 1 and
  // rejects `true`, `NaN` and `Infinity`.
  expect(parseResponse(bad(0)).answers["q0"]).toEqual({ type: "noul", noul: 0 });
  expect(parseResponse(bad(1)).answers["q0"]).toEqual({ type: "noul", noul: 1 });
  expect(() =>
    parseResponse({
      model: "jev-1.13.0",
      answers: { q0: { type: "noul", noul: true } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  ).toThrow(expect.objectContaining({ kind: "protocol" }));
  const withExtras = {
    model: "jev-1.13.0",
    answers: { q0: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 9 },
    trace_id: "abc",
  };
  const parsed = parseResponse(withExtras);
  expect(parsed).toEqual({
    model: "jev-1.13.0",
    answers: { q0: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  // SC5 says the REQUEST schema too, not only the response. A body this package builds and
  // cannot validate is its own mistake, so it is a `config` error.
  expect(() => parseRequest({ model: "", questions: {}, state: "x" })).toThrow(
    expect.objectContaining({ kind: "config" }),
  );
  expect(
    parseRequest({
      state: "x",
      model: "jev-latest",
      questions: { q0: { type: "noul", instructions: "urgent?" } },
    }).model,
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
    expect([...(mine.required ?? [])].sort()).toEqual([...(theirs.required ?? [])].sort());
    expect(Object.keys(mine.properties ?? {}).sort()).toEqual(
      Object.keys(theirs.properties ?? {}).sort(),
    );
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

const both = [
  { endpoint: "POST /v1/systemone", call: (c: Client): Promise<unknown> => c.evaluate(request) },
  { endpoint: "GET /v1/models", call: (c: Client): Promise<unknown> => c.models() },
] as const;

test.each(both)("$endpoint: 401 is auth and is not retried", async ({ call }) => {
  const server = await startServer([{ status: 401, body: "" }]);
  await expect(call(clientFor(server.baseUrl))).rejects.toMatchObject({ kind: "auth" });
  expect(server.received).toHaveLength(1);
  expect(server.received[0]?.headers["authorization"]).toBe("Bearer test-key");
  await server.close();
});

test("422 carries the body verbatim and is not retried", async () => {
  const body = '{"error":{"field":"questions.q0.criteria","message":"too many options"}}';
  const server = await startServer([{ status: 422, body }]);
  await expect(clientFor(server.baseUrl).evaluate(request)).rejects.toMatchObject({
    kind: "invalid",
    body,
  });
  expect(server.received).toHaveLength(1);
  await server.close();
});

test.each(both)(
  "$endpoint: 429 with retry-after: 1 is retried after that delay",
  async ({ endpoint, call }) => {
    const ok = endpoint === "GET /v1/models" ? MODELS : NOUL;
    const server = await startServer([
      { status: 429, headers: { "retry-after": "1" }, body: "" },
      { status: 200, body: ok },
    ]);
    const started = Date.now();
    const result = await call(clientFor(server.baseUrl));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(server.received).toHaveLength(2);
    expect(result).toBeDefined();
    await server.close();
  },
);

test("a retry-after longer than the cap fails at once and carries the value", async () => {
  const server = await startServer([{ status: 429, headers: { "retry-after": "3600" }, body: "" }]);
  await expect(clientFor(server.baseUrl).evaluate(request)).rejects.toMatchObject({
    kind: "rate_limited",
    retryAfterMs: 3_600_000,
  });
  expect(server.received).toHaveLength(1);
  await server.close();
});

test("529 exhausts the budget, then carries the retry-after it last saw", async () => {
  const server = await startServer([{ status: 529, headers: { "retry-after": "2" }, body: "" }]);
  await expect(clientFor(server.baseUrl, 2).evaluate(request)).rejects.toMatchObject({
    kind: "overloaded",
    retryAfterMs: 2000,
  });
  expect(server.received).toHaveLength(3); // maxRetries + 1
  await server.close();
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
  await server.close();
});

test("a body that closes mid-stream is NOT retried", async () => {
  const server = await startServer([{ cutMidBody: true }]);
  await expect(clientFor(server.baseUrl, 3).evaluate(request)).rejects.toMatchObject({
    kind: "transport",
  });
  // The rejection is a TypeError, exactly like a refused connection. Only the phase tells
  // them apart, and the phase is why this served exactly one request.
  expect(server.received).toHaveLength(1);
  await server.close();
});

// ---- shapes, the guide and the receipt (cases 21-25) -------------------------------------

test("a malformed body and an option outside the rubric are both protocol errors", async () => {
  const guideFor = (baseUrl: string): Guide =>
    new Guide({ apiKey: new ApiKey("k"), baseUrl, backoff: 10 });

  const malformed = await startServer([{ status: 200, body: JSON.stringify(badNoulFixture) }]);
  await expect(guideFor(malformed.baseUrl).ask(noul("Urgent?"), "x")).rejects.toMatchObject({
    kind: "protocol",
  });
  await malformed.close();

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
  await expect(guideFor(ghost.baseUrl).ask(choose(Two, "Which?"), "x")).rejects.toMatchObject({
    kind: "protocol",
  });
  await ghost.close();

  // A redirect is not followed: the Authorization header would travel with it. The status
  // falls through to `unexpected_status` and the host the `location` names sees nothing.
  const elsewhere = await startServer([{ status: 200, body: NOUL_AS_Q0 }]);
  const redirecting = await startServer([
    { status: 302, headers: { location: `${elsewhere.baseUrl}/v1/systemone` }, body: "" },
  ]);
  await expect(guideFor(redirecting.baseUrl).ask(noul("Urgent?"), "x")).rejects.toMatchObject({
    kind: "unexpected_status",
    status: 302,
  });
  expect(elsewhere.received).toHaveLength(0);
  await redirecting.close();
  await elsewhere.close();
});

test("unsure with no fallback names the question; an empty batch is a config error", async () => {
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
  const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl, backoff: 10 });
  await expect(guide.ask(noul("Urgent?").yesAbove(0.9).noBelow(0.1), "x")).rejects.toMatchObject({
    kind: "unsure",
    question: "q0",
  });
  // A fallback resolves it instead of failing.
  await expect(guide.ask(noul("Urgent?").yesAbove(0.9).noBelow(0.1).or(false), "x")).resolves.toBe(
    false,
  );
  await expect(guide.ask([], "x")).rejects.toMatchObject({ kind: "config" });
  await expect(guide.ask({}, "x")).rejects.toMatchObject({ kind: "config" });
  await server.close();
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
  await server.close();
});

test("ask returns the bare answer for every shape", async () => {
  const Department = choice({ billing: option("b"), technical: option("t") });
  const Frustration = levels({ calm: "Calm", frustrated: "Frustrated" });
  const answers = {
    q0: { type: "noul" as const, noul: 0.92 },
    q1: {
      type: "choice" as const,
      choice: "billing",
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.95,
    },
    q2: {
      type: "score" as const,
      score: 1,
      legend: { "0": "Calm", "1": "Frustrated" },
      probabilities: { "0": 0.1, "1": 0.9 },
      confidence: 0.9,
    },
    q3: { type: "noul" as const, noul: 0.1 },
    q4: { type: "noul" as const, noul: 0.8 },
  };
  const body = JSON.stringify({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 11, output_tokens: 2 },
  });
  // Three replies, one per request this case makes: the tuple ask, the bare-question ask, and
  // `models()`. The extra answers the second ask does not need are ignored, because the reply
  // is walked by the plan's question ids rather than by what the body happens to carry.
  const server = await startServer([
    { status: 200, body },
    { status: 200, body },
    { status: 200, body: MODELS },
  ]);
  const guide = new Guide({ apiKey: new ApiKey("k"), baseUrl: server.baseUrl });

  const result = await guide.ask(
    [
      noul("urgent?"),
      choose(Department, "which team?"),
      score(Frustration, "how cross?"),
      { spam: noul("spam?"), vip: noul("vip?") },
    ] as const,
    "a ticket",
  );
  const [urgent, dept, mood, flags] = result;
  expect(urgent).toBe(true);
  expect(dept).toBe("billing");
  expect(mood).toBe("frustrated");
  expect(flags).toEqual({ spam: false, vip: true });

  // The ids are q0..q4 in encounter order, depth first, and the object shape's two questions
  // are the last two because they were written last.
  const sent: unknown = JSON.parse(server.received[0]?.body ?? "{}");
  expect(Object.keys(questionsOf(sent))).toEqual(["q0", "q1", "q2", "q3", "q4"]);

  // A plain array is an array, not a tuple, and a bare question is its own answer.
  await expect(guide.ask(noul("urgent?"), "x")).resolves.toBe(true);

  // models() copies the wire entry into this package's own shape, snake to camel.
  const catalogue = await guide.models();
  expect(catalogue).toEqual([
    {
      name: "jev-latest",
      description: "The most recent stable release",
      releaseDate: "2026-08-01",
    },
  ]);
  expect(Object.isFrozen(catalogue[0])).toBe(true);
  await server.close();

  // And the object-shape ordering rule, in the same case so the budget stays at 40. JavaScript
  // reorders integer-like keys ahead of string keys, so "1" is encountered before "2" whatever
  // the caller wrote. docs/contract.md records this as the TypeScript spelling of the
  // encounter-order rule; the assertion is here so it cannot change unnoticed.
  const twoBody = JSON.stringify({
    model: "jev-1.13.0",
    answers: { q0: { type: "noul", noul: 0.9 }, q1: { type: "noul", noul: 0.1 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const ordered = await startServer([{ status: 200, body: twoBody }]);
  const second = new Guide({ apiKey: new ApiKey("k"), baseUrl: ordered.baseUrl });
  const answered = await second.ask({ "2": noul("second"), "1": noul("first") }, "x");
  const ordering: unknown = JSON.parse(ordered.received[0]?.body ?? "{}");
  expect(questionsOf(ordering)["q0"]?.instructions).toBe("first");
  expect(answered).toEqual({ "1": true, "2": false });
  await ordered.close();
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
  const fakeFetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    expect(url).toContain("/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
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
  expect(realFetch).not.toHaveBeenCalled();
  realFetch.mockRestore();
});
