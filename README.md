# guideme

[![npm](https://img.shields.io/npm/v/@guideme/sdk.svg)](https://www.npmjs.com/package/@guideme/sdk)
[![license](https://img.shields.io/npm/l/@guideme/sdk.svg)](#license)

Judgments from [TypeSafe Jev](https://docs.typesafe.ai) that read like TypeScript control flow.

A yes/no question is an `if`. A choice is an exhaustive `switch` over a union the compiler
checks. A score is a comparison against your own ordered levels. Thresholds, unsure bands and
fallbacks are explicit and composable. Every request is one OpenTelemetry span. The decision
logic is pure and its contract is published under `spec/`, so every guideme SDK, in any
language, answers the same way.

```ts
import { choice, choose, fallback, levels, noul, option, score, Guide } from "@guideme/sdk";
import type { Level, Option } from "@guideme/sdk";

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
```

The description you give each key is the rubric the model reads. The key itself is what goes on
the wire, and the key union is the answer type, so a `switch` that forgets a case does not
compile.

`assertNever` is three lines you own, not an export: the package's surface is thirteen values
and a helper whose whole job is to sit in your `default` arm is not one of them.

Never compare level keys with `>` or `>=`: that is lexical, and `"veryAngry" > "frustrated"` is
a fact about the alphabet. The descriptor carries `atLeast`, `compare`, `index` and `rank`,
and declaration order is level order.

## Examples in a rubric

A description alone leaves confusable options to a coin flip. Name the inputs that belong to
an option, and the ones that do not:

```ts
import { choice, fallback, option } from "@guideme/sdk";

const Department = choice({
  billing: option("Payments, invoicing, refunds", {
    examples: ["My card was charged twice", "Where is my refund?"],
    counterexamples: ["The dashboard is down"],
  }),
  technical: option("Bugs, outages, integrations", { examples: ["502 on every request"] }),
  sales: fallback("Pricing, upgrades, new accounts"),
});
```

`billing` reaches the wire as one string:

```text
Payments, invoicing, refunds
Examples: My card was charged twice; Where is my refund?
Not this option: The dashboard is down
```

An option with neither clause renders to its description unchanged, byte for byte, so nothing
you wrote before moves.

`examples` works on `levels()` too, where an example _is_ the statement that such an input
scores at that level — its position on the scale carries the number, so nothing is added to the
text. `counterexamples` is an option key only: a level is a position on a scale, not an option
to rule out, and asking for one is a **compile error**. The other rules are checked when the
declaration runs, and a broken one throws a `config` error there, before any request: an empty
or duplicated example, an example on an option with no description to attach it to, and an
example that claims an input belongs to two options at once. The same string as an example of
one option and a counterexample of another is exactly the point, and stays legal.

A noul has no descriptor to hang parts off, so it takes the same rubric objects through
`criteria`:

```ts
import { noul, option, type Guide } from "@guideme/sdk";

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
```

This is where examples earn the most: on that ticket, plain criteria answer 0.75 and these
answer 0.25 — and 0.25 is right. `criteria` takes a description or a rubric on either side, so
a plain pair of strings keeps working unchanged.

## Install

```sh
npm install @guideme/sdk
```

Node 22 or newer, or any runtime with `fetch`. The package is ESM only and ships its own
types. Its two runtime dependencies are `zod` and `@opentelemetry/api`, and neither appears on
the public surface.

Set `TYPESAFE_API_KEY` in the environment, or pass a key to `new Guide({ apiKey })`.

Build one `Guide` per process and share it freely, across requests and across concurrent
`ask` calls. A guide is frozen once it is built, and `ask` keeps no state between calls: each
call is its own request, its own span and its own answer. An injected `fetch` is shared the
same way, so it must be safe to call concurrently, which the platform's own `fetch` is.
`guide.withPolicy(..)` returns a second guide that shares the first one's transport.

## The three questions

| Constructor                 | Sends                                     | Plain output                             | `.detail()` output                                                            |
| --------------------------- | ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `noul("…")`                 | a yes/no question                         | `boolean`                                | `Verdict` with the verdict and the probability                                |
| `choose(D, "…")`            | a choice over `D`'s options               | `D`'s key union                          | `Ranked<K>` with confidence and the full distribution                         |
| `score(L, "…")`             | a score over `L`'s levels, low to high    | `L`'s key union, the most probable level | `Scored<K>` with the expected `value`, the level, confidence and distribution |
| `chooseAmong("…", options)` | a choice over runtime key-to-rubric pairs | `Key`                                    | `Ranked<string>`                                                              |
| `scoreLevels("…", levels)`  | a score over runtime level descriptions   | `Rank`, the level **index**              | `Scored<string>`                                                              |

A noul can carry `.criteria(yes, no)`. Instructions accept a string or a plain object, so a
question can reference structured data by field name the way the TypeSafe docs describe.

The runtime pair takes a description or a rubric in every rubric position, so options and
levels that come from a database carry examples the same way a declared one does:

```ts
import { chooseAmong, option, type Guide, type Key } from "@guideme/sdk";

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
```

An option described not at all is `null`, which the wire distinguishes from an option described
as nothing. The rules are the same rules: a shared example, an empty or duplicated one, a
counterexample on a level. A declaration `choice()` accepts is accepted here, and one it
rejects is rejected here.

The state is anything `JSON.stringify` accepts: a string, a number, an object, your own class
with a `toJSON`. It is checked after `toJSON` has run, so what counts is the JSON: a `NaN`, an
`Infinity` or a bigint that would reach it is a `config` error rather than a silent `null`, and
so is a cycle. The same object under two fields is not a cycle.

## Policy

Thresholds decide how a probability or a confidence becomes an answer. They form a patch that
merges from the question, over the guide, over the package defaults.

| Layer    | How to set                                                                                              | Wins over |
| -------- | ------------------------------------------------------------------------------------------------------- | --------- |
| question | `.yesAbove(p)`, `.noBelow(p)` on nouls; `.minConfidence(c)` on choice and score; `.with(policy)` on any | guide     |
| guide    | `new Guide({ policy })`, or `guide.withPolicy(..)` for a scoped copy                                    | defaults  |
| defaults | `yesAbove 0.5`, `noBelow 0.5`, `minConfidence 0.0`                                                      | nothing   |

The rules:

- Noul: `p >= yesAbove` is yes, `p <= noBelow` is no, strictly between is unsure. With the
  defaults there is no unsure band.
- Choice and score: `confidence < minConfidence` is unsure. With the default there is never an
  unsure answer.

When an answer is unsure, resolution goes down a ladder: `.or(value)` on the question, then the
descriptor's `fallback` option, then an `unsure` error naming the question and the boundary it
missed. `.detail()` skips the ladder and hands you the reading to decide yourself — and because
it skips it, a detailed question has no `.or`: `noul("…").detail().or(x)` does not compile,
rather than compiling and discarding `x`.

Every type you can reach is exported by name, so a signature never has to spell
`ReturnType<..>`: `.detail()` returns a `DetailedNoulQuestion`, a
`DetailedChoiceQuestion<Ranked<K>>` or a `DetailedScoreQuestion<Scored<K>>`, and `choice` and
`levels` return a `ChoiceDescriptor<K>` and a `LevelsDescriptor<K>`. Naming a descriptor does
not let you build one: it still has to come from `choice` or `levels`.

A **runtime** choice has two rungs, not three. `chooseAmong` answers a `Key`, and there is no
descriptor to carry a marked option, so handing it a `fallback()` value is a `config` error
naming the rule. Use `.or(key)`.

A house policy is a plain object:

```ts
import { noul, ApiKey, Guide, type Policy } from "@guideme/sdk";

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
```

A bad patch fails where it is written: `withPolicy` validates immediately, not at the first ask.

## Several judgments, one request

A tuple of questions is a question. So is an array and a plain object, and they nest. The
answer has the same shape, from one request and one span. Each question keeps its own policy.

```ts
const answers = await guide.ask(
  [
    noul("Is this urgent?").yesAbove(0.7).noBelow(0.3).or(false),
    choose(Department, "Which team?").minConfidence(0.6),
    score(Frustration, "How frustrated?").detail(),
    { spam: noul("Is it spam?"), vip: noul("Is the sender a VIP?") },
  ] as const,
  ticket,
);
```

`answers` is
`readonly [boolean, Department, Scored<Frustration>, { readonly spam: boolean; readonly vip: boolean }]`,
and that type is asserted in `test/typing.test-d.ts` rather than written here and hoped for.

The `as const` is what makes it a tuple. Without it the array widens and the answer is
`readonly boolean[]`, which is the right type for a list built at runtime. Both are supported
and both are proved.

Question ids are `q0..qN` in encounter order; they appear on the wire, in errors and in events.
A batch is atomic: one answer that cannot be resolved fails the whole call, so put `.or(..)` or
`.detail()` on the questions that may come back unsure.

## Observability

guideme emits OpenTelemetry spans and events and installs nothing: no provider, no exporter, no
context manager. Install a provider and it appears. The smallest one:

```ts
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";

trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())] }),
);
```

One span named `guideme.ask` per request, shaped by the OpenTelemetry GenAI conventions:
`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.*`, and on failure `error.type`
with an error status. Under it, one HTTP client span per attempt with
`http.response.status_code`, so a retry is visible as sibling spans, plus a `guideme.retry`
event when an attempt is throttled. One `guideme.answer` event per question with the outcome,
the probability or confidence, the unsure verdict and the settled thresholds that produced it.
The state is never recorded unless you opt in with `recordState: true`. The API key never
appears anywhere.

The nesting comes from the OpenTelemetry context manager, which an application installs and
this package does not: `NodeSDK` and `NodeTracerProvider` install one, a bare
`BasicTracerProvider` does not, and without one every span is a root.

Because the shapes are standard, any OTLP backend reads them as is.
[`docs/observability.md`](docs/observability.md) has the field tables, the sampler matrix, the
environment variables that point the exporter anywhere, and console and OTLP setups.
`examples/otlp` runs all of it against the live API with a collector that prints what arrives.

## Errors

One class, `GuidemeError`, for everything, discriminated by `kind`. Its constructor is public,
with its third argument typed `GuidemeErrorOptions`, so a test double can throw the class you
branch on:

| `kind`              | When                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`              | 401                                                                                                                                                      |
| `invalid`           | 422, body on `.body`; an unreadable body leaves `.body` unset and the read failure on `.cause`                                                           |
| `rate_limited`      | 429 after retries, or a `retry-after` too long to wait for; `.retryAfterMs`                                                                              |
| `overloaded`        | 529, same                                                                                                                                                |
| `transport`         | connection, TLS, timeout, or a 200 whose body failed to read                                                                                             |
| `unexpected_status` | anything the contract does not define, including a 3xx; `.status` and `.body`                                                                            |
| `protocol`          | the response violates the contract: undecodable body, wrong answer kind, option or level not in the rubric, probability outside 0..1, a blank model name |
| `unsure`            | the policy said unsure and nothing caught it; `.question` names it                                                                                       |
| `config`            | bad thresholds, missing key, empty batch, unserialisable state, empty or duplicate rubric, a `maxRetries`, `backoff` or `timeout` out of range           |

Retries use exponential backoff with jitter, capped at 30 s, and honour an integer
`retry-after`. What is retried: 429, 529, and a request that never reached a server — a refused
or reset connection, a TLS handshake failure. A connect timeout raised by the runtime's own
`fetch` — undici's, about 10 s, in Node — is one of these: it rejects as a `TypeError`, like a
refused connection, and is retried. Both endpoints, so a throttle on a startup `models()` call
does not fail the boot. What is not: **this package's own `timeout`**, in any phase, or a body
failure. `timeout` is one deadline over the whole attempt, so retrying it would multiply the
wall time that setting promises.

A redirect is **not** followed. The `Authorization` header would travel with it, and whether it
survives a cross-origin hop is the runtime's rule rather than this package's, so a 3xx surfaces
as `unexpected_status` and the host it named sees nothing.
[`docs/contract.md`](docs/contract.md) records that Rust chose otherwise.

## The receipt

`ask` returns the answer. `askWithReceipt` returns the same answer plus what the response said
about itself: the versioned model that produced it, and the tokens it cost.

```ts
const receipt = await guide.askWithReceipt(noul("Urgent?"), ticket);
receipt.answer; // true
receipt.model; // "jev-1.13.0" — the versioned id, not the alias that was sent
receipt.usage; // { inputTokens: 307, outputTokens: 20 } — input tokens are the billed ones
```

Same request, same span, same fields. `ask` is this with everything but the answer dropped.

## Testing your code

Hand in a `fetch` that answers from memory and your control flow runs with no network, no
server and no API key. This is the body of a real test in this repository, which is how it
stays true:

```ts
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
```

Question ids are `q0..qN` in encounter order, so a batch answers `q0`, `q1` and so on in the
order you wrote it.

`fetch` is a platform type, so there is no library to add and no version to keep in step. The
same seam takes a proxy, a client certificate or a transport shared with the rest of the
application: build your own `fetch` — an `undici` `Agent`, a wrapper that adds a header, a
retrying pool — and hand it in. Everything else the guide carries, including `timeout`, still
applies to it; `timeout` is an `AbortSignal.timeout` passed as the request's `signal`.

Or point the guide at a local server instead, with `baseUrl`, and nothing else changes.

## Lower layers

- `resolve(answer, thresholds)` is the pure decision function. `spec/` holds its JSON Schemas,
  42 golden policy vectors and the rubric rendering cases; guideme-rust's `docs/contract.md`
  states what every guideme SDK must satisfy, and [`docs/contract.md`](docs/contract.md) here
  records what is specific to this one. [`docs/design.md`](docs/design.md) records the design
  and its sharp edges.
- Neither the wire schemas nor the HTTP client are exported. The transport seam is `fetch`
  injection, which needs no type of ours on the surface.

## Other SDKs

Every guideme SDK is written from scratch in its own language and answers the same way, because
they all satisfy the contract guideme-rust publishes under `spec/`: the wire schemas, the 42
golden policy vectors, the rubric rendering, and the interface shape.

| Language   | Package                                                      | Repository                                                        |
| ---------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Rust       | [`guideme`](https://crates.io/crates/guideme)                | [guideme-rust](https://github.com/pedro-pscunha/guideme-rust)     |
| Python     | [`guideme`](https://pypi.org/project/guideme/)               | [guideme-python](https://github.com/pedro-pscunha/guideme-python) |
| TypeScript | [`@guideme/sdk`](https://www.npmjs.com/package/@guideme/sdk) | this repository                                                   |

They emit the same span, event and attribute names, so one dashboard reads all three.

## Environment

| Variable            | Meaning                                       |
| ------------------- | --------------------------------------------- |
| `TYPESAFE_API_KEY`  | required by `Guide.fromEnv`                   |
| `TYPESAFE_BASE_URL` | optional API origin override                  |
| `GUIDEME_MODEL`     | optional model or alias; default `jev-latest` |

`Guide.fromEnv()` is the one-liner. It takes an optional overrides object, so a house policy
and an environment key compose: `Guide.fromEnv({ policy: CAUTIOUS })`. An override wins, and
the variable it replaces is not read at all.

The rest of the options: `model`, `policy`, `maxRetries` (default 3), `backoff` (default 500 ms,
the base of the exponential), `timeout` (default 30 s, per attempt), `recordState`, and `fetch`
for an injected transport. `maxRetries` must be a non-negative integer, `backoff` a finite
number of milliseconds of at least 0, and `timeout` above 0 and at most 2 147 483 647 ms
(2^31 - 1), the longest delay a timer holds; Node would clamp a larger one to 1 ms. Anything
else is a `config` error when the guide is built.

## Development

Tooling is managed by [mise](https://mise.jdx.dev); `mise install` fetches Node, Bun and
gitleaks at the pinned versions.

```sh
mise install
bun install
mise run check    # fmt-check, lint, types, readme, fallow, test, build, surface, publint, attw, audit
mise run test     # vitest, including the typecheck file
mise run hooks    # point core.hooksPath at the tracked hooks in .githooks
```

The hooks are tracked, not generated: `mise run hooks` sets this repository's `core.hooksPath`
to `.githooks` and verifies it took effect. [`AGENTS.md`](AGENTS.md) says what each stage runs.

Library code is held to a strict lint set: `strictTypeChecked` and `stylisticTypeChecked`, with
`any`, `!` and `as` denied, `isolatedDeclarations` on, and `fallow` at zero findings across
dead code, duplication and health with no baseline. Tests are few and high-grade: property
tests for the policy laws, a real local `node:http` server for the wire and retry contract,
structural tracing assertions through `InMemorySpanExporter`, and a typecheck file whose
`@ts-expect-error` lines fail the build when they stop being errors. There are forty of them,
and `AGENTS.md` lists every one with the reason it exists.

Two opt-in tests hit the real API and are skipped by default:

```sh
TYPESAFE_API_KEY=… LIVE=1 bun run vitest run test/live.test.ts
```

Contributor rules live in [`AGENTS.md`](AGENTS.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md). Report a vulnerability privately, as
[`SECURITY.md`](SECURITY.md) describes, never in a public issue.

## License

MIT or Apache-2.0, at your option.
