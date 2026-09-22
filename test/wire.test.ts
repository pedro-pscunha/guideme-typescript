import { expect, test, vi } from "vitest";
import noulFixture from "./fixtures/noul.json" with { type: "json" };
import choiceFixture from "./fixtures/choice.json" with { type: "json" };
import scoreFixture from "./fixtures/score.json" with { type: "json" };
import { parseModels, parseRequest, parseResponse, schemaShapes } from "../src/api/wire.js";
import modelsFixture from "./fixtures/models.json" with { type: "json" };
import requestJson from "../spec/schema/request.json" with { type: "json" };
import responseJson from "../spec/schema/response.json" with { type: "json" };
import { closedPort, startServer } from "./support/server.js";
import { ApiKey } from "../src/index.js";
import { createClient } from "../src/api/client.js";
import type { Client } from "../src/api/client.js";

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
