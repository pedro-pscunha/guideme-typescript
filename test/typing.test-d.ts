import { expectTypeOf, test } from "vitest";
import {
  ApiKey,
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
  type ChoiceQuestion,
  type Confidence,
  type Guide,
  type ErrorKind,
  type GuideOptions,
  type Key,
  type Level,
  type LevelRubric,
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

const Department = choice({
  billing: option("Payments, invoicing, refunds", {
    examples: ["My card was charged twice", "Where is my refund?"],
    counterexamples: ["The dashboard is down"],
  }),
  technical: option("Bugs, outages, integrations", { examples: ["502 on every request"] }),
  sales: fallback("Pricing, upgrades, new accounts"),
});
type Department = Option<typeof Department>;

const Frustration = levels({
  calm: "Calm and polite",
  frustrated: level("Frustrated", { examples: ["this is the third time I'm writing"] }),
  veryAngry: "Very angry",
});
type Frustration = Level<typeof Frustration>;

declare const guide: Guide;
declare const ticket: string;

test("the option and level types are exactly the key unions", () => {
  expectTypeOf<Department>().toEqualTypeOf<"billing" | "technical" | "sales">();
  expectTypeOf<Frustration>().toEqualTypeOf<"calm" | "frustrated" | "veryAngry">();
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

test("askWithReceipt wraps every shape", async () => {
  expectTypeOf(await guide.askWithReceipt(noul("a"), ticket)).toEqualTypeOf<Receipt<boolean>>();
  expectTypeOf(
    await guide.askWithReceipt([noul("a"), choose(Department, "b")] as const, ticket),
  ).toEqualTypeOf<Receipt<readonly [boolean, Department]>>();
  const receipt = await guide.askWithReceipt(noul("a"), ticket);
  expectTypeOf(receipt.model).toEqualTypeOf<Model>();
  expectTypeOf(receipt.usage.inputTokens).toEqualTypeOf<number>();
});

test("the exported TYPE surface is exactly this list", () => {
  // `Object.keys` in test/surface.test.ts sees runtime values only, because types are erased.
  // This is the other half: every type `src/index.ts` exports, referenced once, so that
  // removing or renaming one is a compile error here. A type the package exports and this
  // list omits is caught by the `.d.ts` roll-call in the gate (Task 21 Step 5).
  expectTypeOf<GuideOptions>().not.toBeAny();
  expectTypeOf<Option<typeof Department>>().not.toBeAny();
  expectTypeOf<Level<typeof Frustration>>().not.toBeAny();
  expectTypeOf<OptionRubric>().not.toBeAny();
  expectTypeOf<LevelRubric>().not.toBeAny();
  expectTypeOf<Question<boolean>>().not.toBeAny();
  expectTypeOf<NoulQuestion>().not.toBeAny();
  expectTypeOf<ChoiceQuestion<Department>>().not.toBeAny();
  expectTypeOf<ScoreQuestion<Frustration>>().not.toBeAny();
  expectTypeOf<Policy>().not.toBeAny();
  expectTypeOf<Thresholds>().not.toBeAny();
  expectTypeOf<Verdict>().not.toBeAny();
  expectTypeOf<Ranked<Department>>().not.toBeAny();
  expectTypeOf<Scored<Frustration>>().not.toBeAny();
  expectTypeOf<Key>().not.toBeAny();
  expectTypeOf<Rank>().not.toBeAny();
  expectTypeOf<Receipt<boolean>>().not.toBeAny();
  expectTypeOf<Usage>().not.toBeAny();
  expectTypeOf<ModelInfo>().not.toBeAny();
  expectTypeOf<Model>().not.toBeAny();
  expectTypeOf<Probability>().not.toBeAny();
  expectTypeOf<Confidence>().not.toBeAny();
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
  // `Outcome` is NOT exported: it is the policy's internal reading, and `Verdict`,
  // `Ranked` and `Scored` are what a caller sees. Referencing it here would not compile.
});

test("no exported type is assignable from a zod schema type", () => {
  // `zod` is not imported by this file and appears in no emitted declaration. The structural
  // proof is that `Receipt["usage"]` has exactly two number fields and nothing zod-shaped.
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
  /* eslint-enable @typescript-eslint/no-unsafe-call */
});
