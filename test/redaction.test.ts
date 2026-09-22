import { expect, test } from "vitest";
import { inspect } from "node:util";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { startServer } from "./support/server.js";
import { ApiKey, Guide, noul } from "../src/index.js";
import noulQ0 from "./fixtures/noul-q0.json" with { type: "json" };

const NOUL_AS_Q0 = JSON.stringify(noulQ0);

const SECRET = "sk-live-51H9ZqLmDoNotPrintMeAnywhere";

test("every string view of a key and of a guide is redacted", () => {
  const k = new ApiKey(SECRET);
  const views = [
    String(k),
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- interpolating a key is precisely what this case exists to check; the lint rule and the assertion want opposite things
    `${k}`,
    // eslint-disable-next-line @typescript-eslint/restrict-plus-operands -- `+` on a key is precisely what this case exists to check; the lint rule and the assertion want opposite things
    k + "",
    k[Symbol.toPrimitive](),
    JSON.stringify(k),
    JSON.stringify({ key: k }),
    inspect(k),
    inspect({ key: k }),
    inspect({ deep: { key: k } }, { depth: 5 }),
    k.toString(),
    k.toJSON(),
  ];
  for (const view of views) expect(view).not.toContain("sk-live");
  expect(String(k)).toBe("ApiKey(***)");
  const roundTripped: unknown = JSON.parse(JSON.stringify(k));
  expect(roundTripped).toBe("ApiKey(***)");

  const guide = new Guide({ apiKey: k });
  for (const view of [String(guide), inspect(guide), JSON.stringify(guide)]) {
    expect(view).not.toContain("sk-live");
  }
});

test("the key is on no span attribute and in no event", async () => {
  const exporter = new InMemorySpanExporter();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
  const server = await startServer([{ status: 200, body: NOUL_AS_Q0 }]);
  const guide = new Guide({
    apiKey: new ApiKey(SECRET),
    baseUrl: server.baseUrl,
    recordState: true,
  });
  await guide.ask(noul("Urgent?"), { note: "hello" });
  const serialised = JSON.stringify(
    exporter.getFinishedSpans().map((s) => ({
      name: s.name,
      attributes: s.attributes,
      status: s.status,
      events: s.events,
    })),
  );
  expect(serialised).not.toContain("sk-live");
  expect(serialised).not.toContain("Bearer");
  await server.close();
});

test("the Authorization value appears in no thrown error", async () => {
  const bodies = [
    { status: 401, body: "" },
    { status: 422, body: `{"error":"bad"}` },
    { status: 418, body: "teapot" },
    { status: 200, body: "not json" },
  ];
  for (const reply of bodies) {
    const server = await startServer([reply]);
    const guide = new Guide({ apiKey: new ApiKey(SECRET), baseUrl: server.baseUrl, maxRetries: 0 });
    try {
      await guide.ask(noul("Urgent?"), "x");
      expect.unreachable("every reply above must fail");
    } catch (e) {
      // Walk the whole cause chain and the stacks.
      const seen: string[] = [];
      let cursor: unknown = e;
      for (let i = 0; i < 10 && cursor instanceof Error; i += 1) {
        seen.push(cursor.message, cursor.stack ?? "", inspect(cursor, { depth: 6 }));
        cursor = cursor.cause;
      }
      const all = seen.join("\n");
      expect(all).not.toContain("sk-live");
      expect(all).not.toContain("Bearer");
    }
    await server.close();
  }
});
