import { expectTypeOf, test } from "vitest";
import type { ZodType } from "zod";
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import {
  ApiKey,
  Guide,
  choice,
  choose,
  chooseAmong,
  fallback,
  level,
  levels,
  noul,
  option,
  score,
  scoreLevels,
  type ChoiceDescriptor,
  type ChoiceQuestion,
  type Confidence,
  type DetailedChoiceQuestion,
  type DetailedNoulQuestion,
  type DetailedScoreQuestion,
  type ErrorKind,
  type GuideOptions,
  type GuidemeError,
  type GuidemeErrorOptions,
  type Key,
  type Level,
  type LevelRubric,
  type LevelsDescriptor,
  type Model,
  type ModelInfo,
  type NoulQuestion,
  type Option,
  type OptionRubric,
  type Policy,
  type Probability,
  type Question,
  type Rank,
  type Ranked,
  type Receipt,
  type ScoreQuestion,
  type Scored,
  type Thresholds,
  type Usage,
  type Verdict,
} from "../src/index.js";
import type { Answer } from "../src/policy.js";

const Department = choice({
  billing: option("Payments, invoicing, refunds", {
    examples: ["My card was charged twice", "Where is my refund?"],
    counterexamples: ["The dashboard is down"],
  }),
  technical: option("Bugs, outages, integrations", { examples: ["502 on every request"] }),
  sales: fallback("Pricing, upgrades, new accounts"),
});
type Department = Option<typeof Department>;

// The README's own declaration, character for character, so the examples below that name
// `Frustration` are checked against the scale the README actually declares.
const Frustration = levels({
  calm: "Calm and polite",
  frustrated: "Frustrated",
  veryAngry: "Very angry",
});
type Frustration = Level<typeof Frustration>;

declare const guide: Guide;
declare const ticket: string;

test("the option and level types are exactly the key unions", () => {
  expectTypeOf<Department>().toEqualTypeOf<"billing" | "technical" | "sales">();
  expectTypeOf<Frustration>().toEqualTypeOf<"calm" | "frustrated" | "veryAngry">();
  // And a level carrying examples keeps its key, exactly as a plain string level does.
  const WithExamples = levels({
    calm: "Calm and polite",
    frustrated: level("Frustrated", { examples: ["this is the third time I'm writing"] }),
  });
  expectTypeOf(WithExamples.keys).items.toEqualTypeOf<"calm" | "frustrated">();
});

test("a single question yields its own type", async () => {
  expectTypeOf(await guide.ask(noul("Urgent?"), ticket)).toEqualTypeOf<boolean>();
  expectTypeOf(
    await guide.ask(choose(Department, "Which team?"), ticket),
  ).toEqualTypeOf<Department>();
  expectTypeOf(
    await guide.ask(score(Frustration, "How cross?"), ticket),
  ).toEqualTypeOf<Frustration>();
});

test("the README's nested example infers the README's type", async () => {
  const answers = await guide.ask(
    [
      noul("Is this urgent?").yesAbove(0.7).noBelow(0.3).or(false),
      choose(Department, "Which team?").minConfidence(0.6),
      score(Frustration, "How frustrated?").detail(),
      { spam: noul("Is it spam?"), vip: noul("Is the sender a VIP?") },
    ] as const,
    ticket,
  );
  expectTypeOf(answers).toEqualTypeOf<
    readonly [
      boolean,
      Department,
      Scored<Frustration>,
      { readonly spam: boolean; readonly vip: boolean },
    ]
  >();
});

test("an array is an array and an object is a mapped object", async () => {
  // No `as const` here and `ask`'s type parameter carries no `const` modifier, so the argument
  // widens to an array and the answer is an array rather than a two-place tuple. The case
  // above is the same expression with `as const`, and it is a tuple. That pair is the proof.
  expectTypeOf(await guide.ask([noul("a"), noul("b")], ticket)).toEqualTypeOf<readonly boolean[]>();
  expectTypeOf(await guide.ask([noul("a"), noul("b")] as const, ticket)).toEqualTypeOf<
    readonly [boolean, boolean]
  >();
  expectTypeOf(
    await guide.ask({ a: noul("a"), b: choose(Department, "b") }, ticket),
  ).toEqualTypeOf<{
    readonly a: boolean;
    readonly b: Department;
  }>();
});

test("detail switches the output type", async () => {
  expectTypeOf(await guide.ask(noul("a").detail(), ticket)).toEqualTypeOf<Verdict>();
  expectTypeOf(await guide.ask(choose(Department, "a").detail(), ticket)).toEqualTypeOf<
    Ranked<Department>
  >();
  expectTypeOf(await guide.ask(score(Frustration, "a").detail(), ticket)).toEqualTypeOf<
    Scored<Frustration>
  >();
});

test("the runtime constructors yield Key and Rank", async () => {
  const q = chooseAmong("Which label?", { a: option("first", { examples: ["one"] }), b: null });
  expectTypeOf(await guide.ask(q, ticket)).toEqualTypeOf<Key>();
  const r = scoreLevels("How severe?", ["low", level("high", { examples: ["outage"] })]);
  expectTypeOf(await guide.ask(r, ticket)).toEqualTypeOf<Rank>();
});

test("probabilities, confidences and model names are branded where the wire parses them", () => {
  // `resolve` takes these types, so an unvalidated number cannot reach the policy: the only
  // way to make one is the brand function the wire's schema runs.
  expectTypeOf<Extract<Answer, { type: "noul" }>["noul"]>().toEqualTypeOf<Probability>();
  expectTypeOf<Extract<Answer, { type: "choice" }>["probabilities"]>().toEqualTypeOf<
    Readonly<Record<string, Probability>>
  >();
  expectTypeOf<Extract<Answer, { type: "choice" }>["confidence"]>().toEqualTypeOf<Confidence>();
  expectTypeOf<Extract<Answer, { type: "score" }>["probabilities"]>().toEqualTypeOf<
    Readonly<Record<string, Probability>>
  >();
  expectTypeOf<Extract<Answer, { type: "score" }>["confidence"]>().toEqualTypeOf<Confidence>();
  expectTypeOf<ModelInfo["name"]>().toEqualTypeOf<Model>();
});

test("the types a constructor or a method returns are named, not reached through ReturnType", () => {
  // Each of these was once nameable only as `ReturnType<..>` or `Parameters<..>`, and a caller
  // annotating a function would have made that spelling the de facto API.
  expectTypeOf(Department).toEqualTypeOf<ChoiceDescriptor<Department>>();
  expectTypeOf(Frustration).toEqualTypeOf<LevelsDescriptor<Frustration>>();
  expectTypeOf(noul("a").detail()).toEqualTypeOf<DetailedNoulQuestion>();
  expectTypeOf(choose(Department, "a").detail()).toEqualTypeOf<
    DetailedChoiceQuestion<Ranked<Department>>
  >();
  expectTypeOf(score(Frustration, "a").detail()).toEqualTypeOf<
    DetailedScoreQuestion<Scored<Frustration>>
  >();
  expectTypeOf<ConstructorParameters<typeof GuidemeError>[2]>().toEqualTypeOf<
    GuidemeErrorOptions | undefined
  >();
});

test("askWithReceipt wraps every shape", async () => {
  expectTypeOf(await guide.askWithReceipt(noul("a"), ticket)).toEqualTypeOf<Receipt<boolean>>();
  expectTypeOf(
    await guide.askWithReceipt([noul("a"), choose(Department, "b")] as const, ticket),
  ).toEqualTypeOf<Receipt<readonly [boolean, Department]>>();
  const receipt = await guide.askWithReceipt(noul("a"), ticket);
  expectTypeOf(receipt.model).toEqualTypeOf<Model>();
  expectTypeOf(receipt.usage.inputTokens).toEqualTypeOf<number>();
});

/**
 * Every type `src/index.ts` exports, named once, in one declaration.
 *
 * This is the other half of `test/surface.test.ts`: `Object.keys` sees runtime values only,
 * because types are erased. Removing or renaming an export breaks this declaration. It cannot
 * see an export being ADDED — the arity below counts this list, not the module — and
 * `scripts/check-exports.mjs`, run by the gate after the build, is what catches that, against
 * the names `dist/index.d.ts` actually carries. `Outcome` is deliberately absent: it is the
 * policy's internal reading, and `Verdict`, `Ranked` and `Scored` are what a caller sees, so
 * naming it here would not compile.
 */
type ExportedTypes = [
  ChoiceDescriptor<Department>,
  ChoiceQuestion<Department>,
  Confidence,
  DetailedChoiceQuestion<Ranked<Department>>,
  DetailedNoulQuestion,
  DetailedScoreQuestion<Scored<Frustration>>,
  ErrorKind,
  GuideOptions,
  GuidemeErrorOptions,
  Key,
  Level<typeof Frustration>,
  LevelRubric,
  LevelsDescriptor<Frustration>,
  Model,
  ModelInfo,
  NoulQuestion,
  Option<typeof Department>,
  OptionRubric,
  Policy,
  Probability,
  Question<boolean>,
  Rank,
  Ranked<Department>,
  Receipt<boolean>,
  ScoreQuestion<Frustration>,
  Scored<Frustration>,
  Thresholds,
  Usage,
  Verdict,
];

test("the exported TYPE surface is exactly this list", () => {
  expectTypeOf<ExportedTypes["length"]>().toEqualTypeOf<29>();
  expectTypeOf<ErrorKind>().toEqualTypeOf<
    | "auth"
    | "invalid"
    | "rate_limited"
    | "overloaded"
    | "transport"
    | "unexpected_status"
    | "protocol"
    | "unsure"
    | "config"
  >();
});

/** The positions in `ExportedTypes` whose type is a zod schema. `never` when there are none. */
type ZodShaped = {
  [K in keyof ExportedTypes]: ExportedTypes[K] extends ZodType ? K : never;
}[number];

test("no exported type is a zod schema type", () => {
  // Per member, not over the union: a union is assignable to `ZodType` only when every member
  // is, so `.not` on the union would pass with twenty-eight of twenty-nine zod-shaped. The gate
  // also refuses a `zod` reference in `dist/index.d.ts` itself, after the build.
  expectTypeOf<ZodShaped>().toEqualTypeOf<never>();
  expectTypeOf<Receipt<boolean>["usage"]>().toEqualTypeOf<{
    readonly inputTokens: number;
    readonly outputTokens: number;
  }>();
});

const assertNever = (x: never): never => {
  throw new Error(String(x));
};

// `declare` is only legal at module scope, so the ambient values every case below needs are
// hoisted here rather than written inside a test body.
declare const dept: Department;

test("illegal states are compiler errors", () => {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- the missing arm IS the case: the directive below is what proves the compiler reports it
  switch (dept) {
    case "billing":
      break;
    case "technical":
      break;
    // "sales" deliberately missing.
    default:
      // @ts-expect-error a switch that misses a key leaves "sales", which is not never
      assertNever(dept);
  }

  // @ts-expect-error a guide needs an API key: the key-less options a derived guide is built from are not public
  new Guide({});

  // @ts-expect-error the client a derived guide shares is not a public argument
  new Guide({ apiKey: new ApiKey("sk-test") }, {});

  // @ts-expect-error levels() rejects an OptionRubric by type: a level is not an option
  levels({ low: option("low"), high: "high" });

  // @ts-expect-error a fallback() is an OptionRubric and has no place on a scale
  levels({ low: fallback("low"), high: "high" });

  // @ts-expect-error a scale needs at least two levels
  levels({ only: "one" });

  // @ts-expect-error and an empty one has none at all
  levels({});

  // @ts-expect-error a choice needs at least two options
  choice({ only: option("one") });

  // @ts-expect-error and an empty one has none at all
  choice({});

  // @ts-expect-error level() takes examples only; a counterexample on a level is meaningless
  level("x", { counterexamples: ["y"] });

  const optionShaped: { examples: string[]; counterexamples: string[] } = {
    examples: ["y"],
    counterexamples: ["z"],
  };
  // @ts-expect-error and passed through a variable too, where excess-property checks do not run
  level("x", optionShaped);

  // @ts-expect-error a descriptor comes from choice(); a lookalike built by hand has no brand
  choose({ descriptor: "choice", keys: ["a", "b"], rubrics: [], fallbackKey: undefined }, "Which?");

  // Naming the descriptor type does not make a lookalike legal: the brand is still unwritable.
  // @ts-expect-error a value annotated ChoiceDescriptor still has to come from choice()
  const named: ChoiceDescriptor<"a" | "b"> = {
    descriptor: "choice",
    keys: ["a", "b"],
    rubrics: [],
    fallbackKey: undefined,
  };
  expectTypeOf(named).toEqualTypeOf<ChoiceDescriptor<"a" | "b">>();

  // @ts-expect-error a rubric comes from option(); a lookalike built by hand has no brand
  choice({
    a: { rubric: "option", what: "a", examples: [], counterexamples: [], isFallback: false },
    b: option("b"),
  });

  // @ts-expect-error examples is a list of strings, never a bare string
  option("x", { examples: "not a list" });

  // @ts-expect-error a Model is a branded string and an ApiKey is neither
  const m: Model = new ApiKey("sk-test");
  // Read once, so the declaration is not an unused local. The annotation is what the directive
  // above is about; this only keeps it alive.
  expectTypeOf(m).toEqualTypeOf<Model>();

  const Severity = levels({ minor: "minor", major: "major" });
  // @ts-expect-error levels from two different descriptors do not compare
  Frustration.atLeast("calm", "minor");
  // And the same through a value read from the other descriptor, guarded rather than asserted
  // with `!`, because the Invariants forbid a non-null assertion in test code too.
  const first = Severity.keys[0];
  if (first !== undefined) {
    // @ts-expect-error still a different scale, even when the value came from the descriptor
    Frustration.atLeast("calm", first);
  }

  /* eslint-disable @typescript-eslint/no-unsafe-call -- each call below is on a property the
     receiver does not have, which is exactly what its `@ts-expect-error` proves. Suppressing
     the resulting error type per line would put a second comment between the directive and
     the code, and a `@ts-expect-error` applies to the line after it, not to the statement. */

  // @ts-expect-error yesAbove belongs to a noul, not a choice
  choose(Department, "Which?").yesAbove(0.7);

  // @ts-expect-error criteria belongs to a noul, not a choice
  choose(Department, "Which?").criteria("yes", "no");

  // @ts-expect-error minConfidence belongs to a choice or a score, not a noul
  noul("Urgent?").minConfidence(0.6);

  // A detailed question has no unsure rung, so it has no `or`. `readAnswer` dispatches on
  // `detailed` before it looks at a fallback, so a value set here would be discarded without
  // a word; Rust says the same by not implementing `Fallible` for `Detailed<K>`.
  // @ts-expect-error a detailed noul never consults a fallback, so it has no or()
  noul("Urgent?").detail().or({ verdict: "yes", p: 0.9 });

  // @ts-expect-error a detailed choice never consults a fallback, so it has no or()
  choose(Department, "Which?").detail().or("billing");

  // @ts-expect-error a detailed score never consults a fallback, so it has no or()
  score(Frustration, "How cross?").detail().or("calm");

  // And it survives a `with(..)`, because the detailed type's own methods return it.
  // @ts-expect-error still detailed after with(), so still no or()
  noul("Urgent?").detail().with({ yesAbove: 0.9 }).or(true);
  /* eslint-enable @typescript-eslint/no-unsafe-call */
});

// The three routes README.md block 1 calls and leaves to the reader.
declare function routeBilling(): void;
declare function routeTech(): void;
declare function routeSales(): void;

// README.md block 7, the provider setup, at module scope: it is a statement list with no
// locals, and at the README's own indentation its longest line still fits the print width.
// This file is type-checked and never executed, so the registration never happens.
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())] }),
);

test("every README example compiles as written", async () => {
  // `scripts/check-readme.mjs` holds every ```ts block in README.md to a line-for-line copy in
  // this file, `test/wire.test.ts` or `test/rubric-rules.test.ts`. The blocks the other cases
  // do not already carry are here, each in its own scope so their declarations do not collide,
  // and each followed by the type its README text promises.
  // README.md block 1.
  {
    const Department = choice({
      billing: option("Payments, invoicing, refunds"),
      technical: option("Bugs, outages, integrations"),
      sales: fallback("Pricing, upgrades, new accounts"),
    });
    type Department = Option<typeof Department>; // "billing" | "technical" | "sales"

    const Frustration = levels({
      calm: "Calm and polite",
      frustrated: "Frustrated",
      veryAngry: "Very angry",
    });
    type Frustration = Level<typeof Frustration>; // "calm" | "frustrated" | "veryAngry"

    const assertNever = (value: never): never => {
      throw new Error(`unreachable: ${String(value)}`);
    };

    async function triage(ticket: string): Promise<void> {
      const guide = Guide.fromEnv(); // reads TYPESAFE_API_KEY

      if (await guide.ask(noul("Should this ticket be escalated?"), ticket)) {
        // escalate
      }

      route(await guide.ask(choose(Department, "Which team should handle this?"), ticket));

      const mood = await guide.ask(score(Frustration, "How frustrated is the customer?"), ticket);
      if (Frustration.atLeast(mood, "frustrated")) {
        // prioritise
      }
    }

    function route(dept: Department): void {
      switch (dept) {
        case "billing":
          routeBilling();
          break;
        case "technical":
          routeTech();
          break;
        case "sales":
          routeSales(); // also the answer when confidence is below the floor
          break;
        default:
          assertNever(dept); // a compile error if a key is missing
      }
    }
    expectTypeOf<Department>().toEqualTypeOf<"billing" | "technical" | "sales">();
    expectTypeOf<Frustration>().toEqualTypeOf<"calm" | "frustrated" | "veryAngry">();
    expectTypeOf(triage).returns.resolves.toBeVoid();
  }

  // README.md block 3.
  {
    async function urgent(guide: Guide, ticket: string): Promise<boolean> {
      return guide.ask(
        noul("Is this ticket urgent?").criteria(
          option("Something is broken now and nobody can work around it", {
            examples: ["the checkout page is down"],
            counterexamples: ["a nightly job failed and we pull the numbers by hand for now"],
          }),
          "It can wait for the next working day",
        ),
        ticket,
      );
    }
    expectTypeOf(urgent).returns.resolves.toEqualTypeOf<boolean>();
  }

  // README.md block 4.
  {
    async function desk(guide: Guide, ticket: string): Promise<Key> {
      return guide.ask(
        chooseAmong("Which desk?", {
          returns: option("Whether an item can be returned", {
            examples: ["Can I return these?"],
            counterexamples: ["Has my return arrived yet?"],
          }),
          tracking: option("Progress of a return already sent", {
            examples: ["Has my return arrived yet?"],
          }),
        }),
        ticket,
      );
    }
    expectTypeOf(desk).returns.resolves.toEqualTypeOf<Key>();
  }

  // README.md block 5.
  {
    const CAUTIOUS: Policy = { yesAbove: 0.7, noBelow: 0.3 };

    async function route(key: ApiKey, ticket: string): Promise<void> {
      const guide = new Guide({ apiKey: key, policy: CAUTIOUS });
      const strict = guide.withPolicy({ minConfidence: 0.8 });

      const verdict = await strict.ask(noul("Is this about billing?").detail(), ticket);
      switch (verdict.verdict) {
        case "yes":
          break; // billing
        case "no":
          break; // everything else
        case "unsure":
          console.log(`a human decides: ${String(verdict.p)}`);
          break;
      }
    }
    expectTypeOf(route).returns.resolves.toBeVoid();
  }

  // README.md block 8.
  {
    /* eslint-disable @typescript-eslint/no-unused-expressions -- the README reads each field
       as a bare expression with its value in a comment; that is the example as written */
    const receipt = await guide.askWithReceipt(noul("Urgent?"), ticket);
    receipt.answer; // true
    receipt.model; // "jev-1.13.0" — the versioned id, not the alias that was sent
    receipt.usage; // { inputTokens: 307, outputTokens: 20 } — input tokens are the billed ones
    /* eslint-enable @typescript-eslint/no-unused-expressions */
    expectTypeOf(receipt).toEqualTypeOf<Receipt<boolean>>();
  }
});
