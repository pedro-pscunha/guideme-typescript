import { expect, test } from "vitest";
import noulFixture from "./fixtures/noul.json" with { type: "json" };
import choiceFixture from "./fixtures/choice.json" with { type: "json" };
import scoreFixture from "./fixtures/score.json" with { type: "json" };
import { parseModels, parseRequest, parseResponse, schemaShapes } from "../src/api/wire.js";
import modelsFixture from "./fixtures/models.json" with { type: "json" };
import requestJson from "../spec/schema/request.json" with { type: "json" };
import responseJson from "../spec/schema/response.json" with { type: "json" };

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
