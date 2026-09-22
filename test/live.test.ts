import { expect, test } from "vitest";
import { Guide, choice, choose, noul, option } from "../src/index.js";

// Opt-in twice over: a key alone is not consent to spend it. CI sets neither, so both rows
// report skipped there and in every default run.
const enabled = process.env["LIVE"] === "1" && (process.env["TYPESAFE_API_KEY"] ?? "").length > 0;

// The confusable pair the examples feature exists for: both plain rubrics are about returns,
// so without examples a model can route "Has my return arrived yet?" to `returns`.
const Desk = choice({
  returns: option("Whether an item can be returned", {
    examples: ["Can I return these?"],
    counterexamples: ["Has my return arrived yet?"],
  }),
  tracking: option("Progress of a return already sent", {
    examples: ["Has my return arrived yet?"],
  }),
});

test.skipIf(!enabled).each([
  {
    name: "examples steer a confusable choice away from the plain-rubric answer",
    run: async (guide: Guide): Promise<void> => {
      const desk = await guide.ask(
        choose(Desk, "Which desk should answer this?"),
        "Has my return arrived yet?",
      );
      expect(desk, "a counterexample on `returns` must keep the model off it").not.toBe("returns");
    },
  },
  {
    name: "a receipt names a versioned model and bills input tokens",
    run: async (guide: Guide): Promise<void> => {
      const { answer, model, usage } = await guide.askWithReceipt(
        noul("Is this message asking for help?"),
        "My payouts have been failing for three days.",
      );
      expect(typeof answer).toBe("boolean");
      expect(model, "the receipt carries the resolved id, never the alias sent").toMatch(
        /^jev-\d+\.\d+\.\d+$/u,
      );
      expect(usage.inputTokens, "a real call bills its input").toBeGreaterThan(0);
    },
  },
])(
  "live: $name",
  async ({ run }) => {
    await run(Guide.fromEnv());
  },
  60_000,
);
