import { expect, test } from "vitest";
import { choice, chooseAmong, encodeQuestion, levels, noul, scoreLevels } from "../src/question.js";
import type { AnyQuestion } from "../src/question.js";
import { fallback, level, option, render } from "../src/rubric.js";
import type { WireQuestion } from "../src/api/wire.js";

// One question needs no shape mapper, so this goes through `encodeQuestion` rather than
// through `src/ask.ts`: the rules are about what reaches the wire, and this file must compile
// against the modules that exist at this point.
const wireOf = (q: AnyQuestion): WireQuestion => encodeQuestion(q, {}).wire;

const refuses = (what: string, build: () => unknown): void => {
  let thrown: unknown;
  try {
    build();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `${what} must be refused`).toMatchObject({ kind: "config" });
};

test.each([
  {
    rule: 1,
    name: "an empty clause written out",
    contract:
      "refuses an empty clause written out — `examples=[]`, where the caller wrote the clause and put nothing in it",
    build: (): unknown => option("Payments", { examples: [] }),
  },
  {
    rule: 2,
    name: "an empty item",
    contract: "an empty or whitespace-only example or counterexample",
    build: (): unknown => render(option("Payments", { examples: [""] })),
  },
  {
    rule: 3,
    name: "a whitespace-only item",
    contract:
      "empty once characters with the Unicode White_Space property are removed from both ends",
    build: (): unknown => render(option("Payments", { examples: ["  \t "] })),
  },
  {
    rule: 4,
    name: "a duplicate within one clause",
    contract: "a duplicate string within one option's examples or within its counterexamples",
    build: (): unknown => render(option("Payments", { examples: ["a", "a"] })),
  },
  {
    rule: 5,
    name: "one string as an example of two options",
    contract: "the same string as an example of two different options",
    build: (): unknown =>
      chooseAmong("Which desk?", {
        returns: option("Returns", { examples: ["Can I return these?"] }),
        tracking: option("Tracking", { examples: ["Can I return these?"] }),
      }),
  },
  {
    rule: 6,
    name: "one string as an example of two levels",
    contract: "or of two different levels",
    build: (): unknown =>
      scoreLevels("How severe?", [
        level("low", { examples: ["a typo"] }),
        level("high", { examples: ["a typo"] }),
      ]),
  },
  {
    rule: 7,
    name: "one string as an example of both noul criteria",
    contract:
      "Every rule above holds on every path — the shared-example rule applies to the yes/no pair",
    build: (): unknown =>
      noul("Urgent?").criteria(
        option("Urgent", { examples: ["the checkout page is down"] }),
        option("Not urgent", { examples: ["the checkout page is down"] }),
      ),
  },
  {
    rule: 8,
    name: "example and counterexample of one option",
    contract: "the same string as both an example and a counterexample of the same option",
    build: (): unknown => render(option("Payments", { examples: ["x"], counterexamples: ["x"] })),
  },
  {
    rule: 9,
    name: "examples attached to a blank rubric",
    contract: "rejected only where examples were attached to it — you described nothing",
    build: (): unknown => render(option("   ", { examples: ["x"] })),
  },
  {
    rule: 10,
    name: "a counterexample on a level",
    contract: "a counterexample on a level, since an ordered scale has no 'not this option'",
    build: (): unknown =>
      scoreLevels("How severe?", [
        "low",
        option("high", { counterexamples: ["a typo"] }) as unknown as ReturnType<typeof level>,
      ]),
  },
  {
    rule: 11,
    name: "an item containing U+000A",
    contract: "may not contain U+000A or U+000D",
    build: (): unknown => render(option("Payments", { examples: ["a\nb"] })),
  },
  {
    rule: 12,
    name: "an item containing U+000D",
    contract: "may not contain U+000A or U+000D",
    build: (): unknown => render(option("Payments", { examples: ["a\rb"] })),
  },

  // The same rules again, reached through a CONSTRUCTOR rather than through `render`
  // directly. The contract says "Every rule above holds on every path", so a rule that is
  // only ever proven against the renderer is only half proven: a constructor that forgot to
  // call the renderer would pass every row above.
  {
    rule: 2,
    name: "an empty item, through chooseAmong",
    contract: "Every rule above holds on every path, declaration and runtime",
    build: (): unknown => chooseAmong("Which?", { a: option("A", { examples: [""] }), b: null }),
  },
  {
    rule: 3,
    name: "a whitespace-only item, through scoreLevels",
    contract: "Every rule above holds on every path, declaration and runtime",
    build: (): unknown =>
      scoreLevels("How severe?", ["low", level("high", { examples: ["  \t "] })]),
  },
  {
    rule: 4,
    name: "a duplicate within one clause, through noul().criteria()",
    contract: "Every rule above holds on every path, declaration and runtime",
    build: (): unknown => noul("Urgent?").criteria(option("Yes", { examples: ["a", "a"] }), "No"),
  },
  {
    rule: 8,
    name: "example and counterexample of one option, through chooseAmong",
    contract: "Every rule above holds on every path, declaration and runtime",
    build: (): unknown =>
      chooseAmong("Which?", {
        a: option("A", { examples: ["x"], counterexamples: ["x"] }),
        b: null,
      }),
  },
  {
    rule: 9,
    name: "examples attached to a blank rubric, through choice()",
    contract: "rejected only where examples were attached to it — you described nothing",
    build: (): unknown => choice({ a: option("   ", { examples: ["x"] }), b: option("B") }),
  },
  {
    rule: 11,
    name: "an item containing U+000A, through scoreLevels",
    contract: "Every rule above holds on every path, declaration and runtime",
    build: (): unknown =>
      scoreLevels("How severe?", ["low", level("high", { examples: ["a\nb"] })]),
  },
  {
    rule: 12,
    name: "an item containing U+000D, through levels()",
    contract: "Every rule above holds on every path, declaration and runtime",
    build: (): unknown => levels({ low: "low", high: level("high", { examples: ["a\rb"] }) }),
  },

  // The thirteenth row is not a rubric rule but the declaration rule that sits beside them,
  // and it is runtime because there is no type-level count of marked values.
  {
    rule: 13,
    name: "two fallback() values in one choice()",
    contract: "the unsure ladder has one rung to fall to, so a choice has at most one fallback",
    build: (): unknown => choice({ a: fallback("a"), b: fallback("b"), c: option("c") }),
  },

  // The fourteenth is the runtime half of the same ladder. A runtime choice answers `Key`,
  // and Rust's `impl Options for Key` names no fallback variant, so there is no rung for a
  // marked option to be. Refused rather than ignored: a `fallback()` that silently did
  // nothing would be a rung the caller believes they have.
  {
    rule: 14,
    name: "a fallback() value given to chooseAmong",
    contract: "runtime options carry no fallback; the unsure ladder there is .or() then the error",
    build: (): unknown => chooseAmong("Which?", { a: fallback("A"), b: option("B") }),
  },
])("rule $rule: $name is refused", ({ name, build }) => {
  refuses(name, build);
});

test("the must-allow overlap is legal and reaches the wire", () => {
  // An example of one option and a counterexample of ANOTHER is the confusable-options
  // pattern this feature exists for. Assert the bytes, not merely that nothing threw.
  const q = chooseAmong("Which desk?", {
    returns: option("Whether an item can be returned", {
      examples: ["Can I return these?"],
      counterexamples: ["Has my return arrived yet?"],
    }),
    tracking: option("Progress of a return already sent", {
      examples: ["Has my return arrived yet?"],
    }),
  });
  expect(wireOf(q).criteria).toEqual({
    returns:
      "Whether an item can be returned\nExamples: Can I return these?\nNot this option: Has my return arrived yet?",
    tracking: "Progress of a return already sent\nExamples: Has my return arrived yet?",
  });
});

test("a blank rubric with no parts is legal and renders to itself", () => {
  expect(render(option(""))).toBe("");
  expect(render(option("   "))).toBe("   ");
  expect(render(level(""))).toBe("");
  // And it reaches the wire unchanged, which is the 0.1.0 compatibility guarantee.
  expect(wireOf(chooseAmong("Which?", { a: option(""), b: null })).criteria).toEqual({
    a: "",
    b: null,
  });
});

test("blank is the Unicode White_Space property, not String.prototype.trim", () => {
  // U+0085 NEXT LINE: White_Space, so blank. ECMAScript trim() does NOT remove it.
  expect("\u0085".trim()).toHaveLength(1);
  refuses("a lone U+0085 example", () => render(option("Payments", { examples: ["\u0085"] })));

  // U+FEFF ZERO WIDTH NO-BREAK SPACE: NOT White_Space, so NOT blank. trim() DOES remove it.
  expect("\uFEFF".trim()).toHaveLength(0);
  expect(render(option("Payments", { examples: ["\uFEFF"] }))).toBe("Payments\nExamples: \uFEFF");

  // The same divergence on the rubric itself: a lone U+0085 what is blank, U+FEFF is not.
  refuses("examples on a U+0085 rubric", () => render(option("\u0085", { examples: ["x"] })));
  expect(render(option("\uFEFF", { examples: ["x"] }))).toBe("\uFEFF\nExamples: x");

  // And the C0 separators Python strips are NOT White_Space, so they are not blank here.
  expect(render(option("Payments", { examples: ["\u001C"] }))).toBe("Payments\nExamples: \u001C");
});

test("duplicate detection is exact string equality, with no normalisation", () => {
  // Leading space, case, and NFD/NFC forms are three different items, all legal together.
  const rendered = render(option("Payments", { examples: ["a", " a", "A", "é", "é"] }));
  expect(rendered).toBe("Payments\nExamples: a;  a; A; é; é");
  refuses("an exactly repeated example", () =>
    render(option("Payments", { examples: ["a", "a"] })),
  );
  // The blank rule trims and the duplicate rule does not: they deliberately disagree about " a".
  expect(render(option("Payments", { examples: [" a"] }))).toBe("Payments\nExamples:  a");
});

test("a line break is U+000A or U+000D by `includes`, and U+2028 stays legal", () => {
  refuses("U+000A", () => render(option("P", { examples: ["a\nb"] })));
  refuses("U+000D", () => render(option("P", { examples: ["a\rb"] })));
  refuses("CRLF", () => render(option("P", { examples: ["a\r\nb"] })));
  // U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are White_Space, so blank on their
  // own, and harmless embedded. A line-splitting primitive would refuse them; `includes` does
  // not, and the contract says it must not.
  expect("a b".includes("\n") || "a b".includes("\r")).toBe(false);
  expect(render(option("P", { examples: ["a b"] }))).toBe("P\nExamples: a b");
  expect(render(option("P", { examples: ["a b"] }))).toBe("P\nExamples: a b");
  refuses("a lone U+2028", () => render(option("P", { examples: [" "] })));
  // And `what` may contain anything, line breaks included; only items are constrained.
  expect(render(option("first\nsecond"))).toBe("first\nsecond");
});
