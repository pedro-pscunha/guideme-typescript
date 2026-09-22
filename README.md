# guideme (TypeScript)

[![npm](https://img.shields.io/npm/v/@guideme/sdk.svg)](https://www.npmjs.com/package/@guideme/sdk)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](#license)

guideme sends a question and your state to [TypeSafe Jev](https://docs.typesafe.ai), the
TypeSafe model that gives judgments. It gives back the answer as a normal TypeScript value: a
`boolean`, one of your own option keys, or one of your own level keys. Your code then acts on
the answer with an `if`, an exhaustive `switch` or a comparison. It is for programs that make a
decision about text or data, for example where to send a support ticket.

## Install

```sh
npm install @guideme/sdk @opentelemetry/api
```

`@guideme/sdk` is not on npm yet. This command works after the first release.

guideme needs Node 22 or newer, or another runtime with `fetch`. The package is ESM only and
includes its own types. Its one runtime dependency is `zod`. Neither `zod` nor
`@opentelemetry/api` is part of the public API of guideme.

`@opentelemetry/api` is a peer dependency, so name it in the command yourself. npm installs a
peer, but it does not add the peer to your `package.json`. Your own tracing setup imports
`@opentelemetry/api` too. If your application already has a version older than `1.9`, npm
refuses the install (`ERESOLVE`). bun and pnpm show a warning, then use your copy.

Set the API key in the `TYPESAFE_API_KEY` environment variable. To give the key in code, use
`new Guide({ apiKey: new ApiKey("…") })`.

## Quick start

This program asks three questions about one support ticket.

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

const guide = Guide.fromEnv(); // reads TYPESAFE_API_KEY

async function triage(ticket: string): Promise<void> {
  if (await guide.ask(noul("Should this ticket be escalated?"), ticket)) {
    escalate();
  }

  const team = choose(Department, "Which team should handle this?").minConfidence(0.6);
  route(await guide.ask(team, ticket));

  const mood = await guide.ask(score(Frustration, "How frustrated is the customer?"), ticket);
  if (Frustration.atLeast(mood, "frustrated")) {
    prioritize();
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
      routeSales(); // also the answer when confidence is less than 0.6
      break;
    default:
      assertNever(dept); // a compile error if a key is missing
  }
}

await triage("I was charged twice this month");
```

- `ticket` is the _state_: the data that you send with the question, here the text of a support
  ticket. `escalate()`, `prioritize()` and the three `route…()` functions are your own code.
- `noul(…)` asks a yes/no question (TypeSafe calls it a _noul_, and `noul` is its type on the
  wire). `choose(…)` asks a choice, and `score(…)` asks a score.
- Each key of `Department` is an _option_: one possible answer of the choice. The text of each
  option is its _rubric_: the text that tells the model what the option means. The key is what
  goes on the wire (in the HTTP request).
- The answer type is the union of the keys. If you add a department and do not add its `case`,
  the `default` arm does not compile. `assertNever` is three lines of your own code, not an
  export of guideme.
- The levels of `Frustration` go from low to high in declaration order. `atLeast` compares two
  levels by this order.
- `sales` is the _fallback_: the answer when the choice is _unsure_, that is, when its
  confidence is less than `minConfidence`. The default `minConfidence` is 0, so a choice is
  never unsure and the fallback is never used. That is why this choice sets 0.6.

When your program starts, build one guide, as this program does. Then share it in the whole
program. The Configuration section tells why.

## Questions

There are three kinds of question. A yes/no question gives a `boolean`. A choice gives one of
your options, and a score gives one level of your ordered scale. The _instructions_ are the text
of the question: the `"…"` argument of each constructor below. Add `.detail()` to a question to
get the detailed answer in place of the plain answer.

| Constructor                            | Asks                                            | Plain answer                          | Detailed answer (`.detail()`)                                         |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `noul("…")`                            | a yes/no question                               | `boolean`                             | `Verdict`: `verdict` (`"yes"`, `"no"` or `"unsure"`) and `p`          |
| `choose(D, "…")`, `D` from `choice(…)` | a choice over the options of `D`                | a key of `D`                          | `Ranked<K>`: `choice`, `confidence`, `unsure`, `probabilities`        |
| `score(L, "…")`, `L` from `levels(…)`  | a score over the levels of `L`                  | a key of `L`, the most probable level | `Scored<K>`: `value`, `level`, `confidence`, `unsure`, `distribution` |
| `chooseAmong("…", options)`            | a choice over options that you give at run time | `Key`, the option key                 | `Ranked<string>`                                                      |
| `scoreLevels("…", levels)`             | a score over levels that you give at run time   | `Rank`, the level position from 0     | `Scored<string>`                                                      |

The `value` of a score is the probability-weighted level number. The lowest level is 0, and the
value can land between two levels.

Level order is declaration order, from low to high. The _descriptor_ is the object that
`choice(…)` or `levels(…)` returns (here `Frustration`). Use its methods to compare levels:
`atLeast`, `compare`, `index` and `rank`. **Never compare level keys with `>` or `>=`.**
These operators compare the text of the keys in alphabetical order, not the levels. The keys of
`Frustration` are in alphabetical order by chance, so `>` gives the correct answer there. If you
rename one key, `>` can give the wrong answer.

A yes/no question can carry `.criteria(yes, no)`: what yes means and what no means. The
instructions are a string or a plain object. With an object, a question can name fields of a
structured state, as the
[TypeSafe docs](https://docs.typesafe.ai/concepts/how-to-build-with-system-one#use-structure-in-the-questions)
describe.

The state is any value that `JSON.stringify` accepts: a string, a number, an object, or your own
class with a `toJSON` method. guideme examines the value after `toJSON` runs.
`JSON.stringify` writes a `NaN` or an `Infinity` as `null`. guideme refuses them with a `config`
error instead. A bigint or a cycle is a `config` error too. The same object under two fields is
not a cycle.

`guide.models()` returns the models that your account can use, each with `name`, `description`
and `releaseDate`. It is one `GET /v1/models` request, with the same retries as `ask`.

You can write every type that a signature needs by its name. You never have to use
`ReturnType<..>`, except for the argument type of `choice` and `levels`:

- `.detail()` returns a `DetailedNoulQuestion`, a `DetailedChoiceQuestion<Ranked<K>>` or a
  `DetailedScoreQuestion<Scored<K>>`.
- `choice` and `levels` return a `ChoiceDescriptor<K>` and a `LevelsDescriptor<K>`.
- `ask` takes a `Shape` and returns `Answered<S>`, so your own wrapper can be generic the same
  way.
- The constructors take `Instructions`. `option`, `fallback` and `level` take `OptionParts` and
  `LevelParts`.
- `askWithReceipt` returns a `Receipt<T>` with a `Usage`, and `models()` returns
  `readonly ModelInfo[]`.

You cannot write a question, a descriptor or a rubric as an object literal. A question comes
only from `noul`, `choose`, `score`, `chooseAmong` or `scoreLevels`. A descriptor comes only
from `choice` or `levels`, and a rubric only from `option`, `fallback` or `level`.

## When the model is not sure

The model does not answer with a plain yes or an option. For a yes/no question it gives `p`, the
probability of yes. For a choice or a score it gives a confidence. A _threshold_ (`yesAbove`,
`noBelow`, `minConfidence`) is the limit that turns this number into an answer. _Unsure_ means
that the number does not reach the thresholds. The _policy_ is the set of thresholds.

| Layer    | How to set it                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| question | `.yesAbove(p)` and `.noBelow(p)` on a yes/no question, `.minConfidence(c)` on a choice or a score, `.with(policy)` on any question |
| guide    | `new Guide({ policy })`, or `guide.withPolicy(policy)` for a second guide with this policy merged over the policy of the first     |
| defaults | `yesAbove` 0.5, `noBelow` 0.5, `minConfidence` 0                                                                                   |

A threshold on the question wins over the guide, and the guide wins over the defaults.

- Yes/no question: `p >= yesAbove` is yes, `p <= noBelow` is no, and a value between the two is
  unsure. With the defaults, no answer is unsure.
- Choice and score: `confidence < minConfidence` is unsure. With the default, no answer is
  unsure.
- A threshold outside 0..1, or a `noBelow` that is more than `yesAbove`, is a `config` error.
  guideme makes sure that the policy of a guide is valid when you build the guide or call
  `withPolicy`. It makes sure that the thresholds of a question are valid when you ask it.

guideme resolves an unsure answer with the _unsure ladder_. The first step that applies wins:

1. The value from `.or(value)` on the question.
2. The fallback: the option that you declare with `fallback(…)` in `choice(…)`. A score has no
   fallback. A `chooseAmong` choice has none either, and it refuses a `fallback(…)` option with a
   `config` error. For these two, use `.or(..)`.
3. An `unsure` error, which names the question and the threshold that the answer did not reach.

`.detail()` skips the ladder and gives you the detailed answer to decide yourself. It never
fails on an unsure answer. It also removes an `.or(..)` that you set before it. A detailed
question has no `.or`, so `noul("…").detail().or(x)` does
not compile. A policy is a plain object:

```ts
import { noul, ApiKey, Guide, type Policy } from "@guideme/sdk";

const CAUTIOUS: Policy = { yesAbove: 0.7, noBelow: 0.3 };

async function route(key: ApiKey, ticket: string): Promise<void> {
  const guide = new Guide({ apiKey: key, policy: CAUTIOUS });
  // yes at 0.9 or more, no at 0.3 or less, unsure between the two
  const strict = guide.withPolicy({ yesAbove: 0.9 });

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

## Examples and counterexamples

A description alone can leave two similar options to chance. An _example_ is an input that
belongs to an option. A _counterexample_ is an input that does not. `option(…)` and
`fallback(…)` take both.

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

The rubric of `billing` goes on the wire as one string:

```text
Payments, invoicing, refunds
Examples: My card was charged twice; Where is my refund?
Not this option: The dashboard is down
```

A rubric with no examples and no counterexamples goes on the wire unchanged, byte for byte.
`level(…)` takes examples only. An example on a level says that such an input scores at that
level. A level has no counterexamples, because a level is a position on a scale, not an option to
exclude.

A yes/no question takes the same rubrics through `.criteria(yes, no)`. Each side is a plain
description or an `option(…)`. On a yes/no question with a vague meaning, examples help most:

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

[`docs/design.md`](docs/design.md#decisions) records a measured case where examples on a yes/no
question change a wrong answer into a correct one.

The runtime constructors take rubrics too. `chooseAmong` takes an `option(…)` for each key, or
`null` for an option with no rubric. `scoreLevels` takes a plain description or a `level(…)` for
each level, as in `scoreLevels("How severe?", ["Cosmetic", "Degraded", "Blocking"])`.

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

A rubric obeys these rules:

- Leave a clause out to say that there are none. guideme refuses a clause with nothing in it,
  such as `examples: []`.
- An example or a counterexample cannot be blank, contain a line break, or appear twice in one
  clause.
- An input cannot be an example of two options, of two levels, or of the yes and the no.
- An input cannot be an example and a counterexample of one option.
- Examples and counterexamples need a rubric that is not blank. A blank rubric alone is legal.
- An input can be an example of one option and a counterexample of another. This separates two
  options that are easy to confuse.

The compiler refuses a counterexample on a level. Each other broken rule is a `config` error,
before any request. `option(…)` and `level(…)` refuse only a clause with nothing in it.
`choice`, `levels`, `.criteria`, `chooseAmong` and `scoreLevels` apply the other rules.

## Several questions in one request

An array of questions is also a question. So is a plain object of questions, and they can nest.
An array or an object of questions is a _batch_. Its _shape_ is how you arrange the questions,
and the answer has the same shape. It comes from one request, in one [span](#observability). Each question keeps its own policy.

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

The type of `answers` is
`readonly [boolean, Department, Scored<Frustration>, { readonly spam: boolean; readonly vip: boolean }]`.
The `as const` makes the array a tuple. Without it, the answer is an array, for example
`readonly boolean[]` for `[noul(…), noul(…)]`. That is the correct type for a list that you
build at run time.

The question ids are `q0`, `q1` and so on, in the order that guideme reads the shape. Array
items keep their order. Object keys go in `Object.keys` order: integer-like keys first, in
number order, then the other keys in insertion order. The ids appear on the wire, in errors and
in events.

A batch is atomic. If guideme cannot resolve one answer, the whole call fails. Put `.or(..)` or
`.detail()` on each question that can be unsure.

## The receipt

`askWithReceipt` sends the same request and records the same span as `ask`. It returns a
`Receipt`: the answer, the versioned model that answered, and the token usage. If you asked for
an alias such as `jev-latest`, the model is still a version such as `jev-1.13.0`.

```ts
const receipt = await guide.askWithReceipt(noul("Urgent?"), ticket);
receipt.answer; // true
receipt.model; // "jev-1.13.0" — the versioned id, not the alias that was sent
receipt.usage; // { inputTokens: 307, outputTokens: 20 } — input tokens are the billed ones
```

`ask` is `askWithReceipt` followed by `.answer`.

## Errors

Every failure is a `GuidemeError`. Its `kind` is the _error kind_: the same string in every
guideme SDK, and the `error.type` of the failed span. With `assertNever` in the `default` arm,
the compiler makes sure that a `switch` over `kind` handles every kind. The constructor is
public, with a third argument of type `GuidemeErrorOptions`, so a test double can throw the same
class.

| `kind`              | When                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`              | HTTP 401: the API key is missing or not valid                                                                                                                                                             |
| `invalid`           | HTTP 422. `.body` holds the response body. If guideme cannot read the body, `.body` is unset and `.cause` holds the read failure.                                                                         |
| `rate_limited`      | HTTP 429 after the last retry, or a `retry-after` of more than 30 s. `.retryAfterMs` holds the `retry-after`, if the API sent one.                                                                        |
| `overloaded`        | HTTP 529, on the same terms as `rate_limited`                                                                                                                                                             |
| `transport`         | a connection, TLS or timeout failure, or a failure to read the body of a 200                                                                                                                              |
| `unexpected_status` | a status that the contract does not define, a 3xx included. `.status` and `.body` hold it.                                                                                                                |
| `protocol`          | the response breaks the contract: a body that does not decode, the wrong answer kind, an option or level not in the rubric, a probability outside 0..1, a blank model name from the API, a missing answer |
| `unsure`            | the answer is unsure and nothing on the unsure ladder caught it. `.question` holds the question id.                                                                                                       |
| `config`            | a mistake in your code, found before anything is sent: see the list below                                                                                                                                 |

A `config` error comes from one of these:

- thresholds outside 0..1, or a `noBelow` that is more than `yesAbove`
- no API key, or a blank one
- a blank `GUIDEME_MODEL`
- a base URL that does not parse, has no host or port, or holds credentials
- a `maxRetries`, `backoff` or `timeout` out of range
- an empty batch, or a shape that is not a question, an array or an object
- a question not built by its constructor
- a state that does not convert to JSON
- a rubric that breaks a rule, two fallbacks, or a fallback in `chooseAmong`
- a wrong number of options (1 to 255) or levels (2 to 10)

## Retries and timeouts

guideme retries HTTP 429, HTTP 529, and a request that did not reach a server. A refused or reset
connection and a failed TLS handshake are failures of this kind. So is a connect timeout that the
`fetch` of the runtime raises itself (in Node, the undici timeout of about 10 s). The runtime
rejects it with a `TypeError`, as it does a refused connection. `GET /v1/models` gets the same
retries as `POST /v1/systemone`. So a 429 on a `models()` call at startup does not stop your
program.

guideme does not retry its own `timeout`, in any phase, or a failure to read the body. The
`timeout` setting (see [Configuration](#configuration)) is one deadline for each attempt. A retry
after it multiplies the wall time that the setting promises. The longest call takes about
`(maxRetries + 1) × timeout`, plus the waits.

The wait before a retry is `backoff × 2^attempt`, with a maximum of 30 s, plus up to 250 ms of
jitter. If the API sends a `retry-after` in whole seconds, guideme waits that long instead. If
the `retry-after` is more than 30 s, the call fails at once, and the error carries that
duration.

guideme does not follow a redirect. The `Authorization` header goes with a redirect, and the
runtime decides whether the header goes to another origin. So a 3xx is an `unexpected_status`
error, and the host that the redirect names gets no request.
[`docs/contract.md`](docs/contract.md) records that the Rust SDK follows redirects.

## Testing your code

Give the guide a `fetch` that answers from memory. Then your control flow runs with no network,
no server and no API key. This code is the body of a test in this repository, so it stays
correct:

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

In the fake response, use the question ids from [Several questions in one
request](#several-questions-in-one-request). This batch has two questions, so the ids are `q0`
and `q1`.

To replace the _transport_, give the guide your own `fetch`. Do this for a proxy, a client
certificate or a connection pool that your program shares. To use a local server instead, set
`baseUrl`.

`fetch` is a platform type, so you add no library. Such a `fetch` can use an `undici` `Agent`, or
add a header and then call the platform `fetch`. Every other setting of the guide still applies
to it: `timeout` is an `AbortSignal.timeout` that guideme gives as the `signal` of each request.

## Observability

guideme emits OpenTelemetry spans and events. It installs no provider, no exporter and no
context manager, so you see nothing until you install a provider. Install the OpenTelemetry
SDK:

```sh
npm install @opentelemetry/sdk-trace-base
```

Then add the smallest setup:

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

Each `ask` is one `guideme.ask` span with the OpenTelemetry GenAI fields, and each HTTP attempt
under it is one more span. A retry adds a `guideme.retry` event. Each question adds a
`guideme.answer` event with the outcome, the probability or confidence, and the thresholds. A
`models()` call has only the HTTP span. guideme records the state only with `recordState: true`,
and never records the API key.

**The spans nest only under an OpenTelemetry context manager.** Your application installs it,
not guideme. `NodeSDK` and `NodeTracerProvider` install one. A `BasicTracerProvider` alone does
not, so with the setup above every span is a root.

[`docs/observability.md`](docs/observability.md) has every field, the sampler matrix, and
console and OTLP setups. [`examples/otlp`](examples/otlp) runs it all against the live API, with
a collector that prints what arrives.

## Configuration

Each _setting_ is a field of the object that you give to `new Guide({ … })`. The second column
shows what `Guide.fromEnv()` reads.

| Setting       | Environment variable | Default                   | Meaning                                                                                |
| ------------- | -------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `apiKey`      | `TYPESAFE_API_KEY`   | none                      | the API key, an `ApiKey`. Required.                                                    |
| `baseUrl`     | `TYPESAFE_BASE_URL`  | `https://api.typesafe.ai` | the API origin                                                                         |
| `model`       | `GUIDEME_MODEL`      | `jev-latest`              | the model or alias, a `Model`: the `name` of an entry that `guide.models()` returns    |
| `policy`      |                      | the defaults above        | the policy for every question of this guide                                            |
| `maxRetries`  |                      | 3                         | retries for 429, 529 and a failure to connect. A non-negative integer.                 |
| `backoff`     |                      | 500 (500 ms)              | the base of the exponential wait, in milliseconds. A finite number, 0 or more.         |
| `timeout`     |                      | 30 000 (30 s)             | the deadline for each attempt, in milliseconds. More than 0 and at most 2 147 483 647. |
| `recordState` |                      | `false`                   | record the state on the span                                                           |
| `fetch`       |                      | the global `fetch`        | the transport                                                                          |

A setting out of range is a `config` error when you build the guide. `Guide.fromEnv()` reads the
variables and builds the guide. It needs `TYPESAFE_API_KEY`. It also takes settings that win over
the variables: `Guide.fromEnv({ policy: CAUTIOUS })`. If a setting replaces a variable, guideme
does not read that variable.

Build one guide per process. Share it across requests and across `ask` calls that run at the
same time. A guide does not change after you build it, and `ask` keeps no state between calls.
Each call is its own request, its own span and its own answer. `guide.withPolicy(..)` returns a
second guide that shares the transport of the first. All the calls share one `fetch`, so an
injected `fetch` must be safe to call at the same time. The platform `fetch` is.

## Other SDKs

Each guideme SDK is written from scratch in its own language. Each one passes the same 42 golden
policy vectors and renders rubrics the same way.
[guideme-rust](https://github.com/pedro-pscunha/guideme-rust) publishes this contract under
`spec/`. So the same probability or confidence and the same thresholds give the same answer in
each SDK. The span, event and attribute names are shared, so one dashboard reads every SDK.

The redirects and one retry rule are not the same in every SDK.
[`docs/contract.md`](docs/contract.md#6-this-client-does-not-follow-redirects-the-rust-client-does)
records that this SDK does not follow redirects.
[`docs/design.md`](docs/design.md#the-ones-this-sdk-had-to-decide-for-itself) records that it
retries the connect timeout of the runtime, and what the other SDKs do.

| Language   | Package                                        | Repository                                                        |
| ---------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| Rust       | [`guideme`](https://crates.io/crates/guideme)  | [guideme-rust](https://github.com/pedro-pscunha/guideme-rust)     |
| Python     | [`guideme`](https://pypi.org/project/guideme/) | [guideme-python](https://github.com/pedro-pscunha/guideme-python) |
| TypeScript | `@guideme/sdk` (not yet on npm)                | this repository                                                   |

## Development

Tools come from [mise](https://mise.jdx.dev). Run `mise install`, `bun install` and
`mise run hooks` once. `mise run check` runs the full gate. [`CONTRIBUTING.md`](CONTRIBUTING.md)
is the short guide, and [`AGENTS.md`](AGENTS.md) has the full rules, the tests and the live tests.
[`docs/design.md`](docs/design.md) records the design decisions and the sharp edges. Report a
vulnerability privately, as [`SECURITY.md`](SECURITY.md) describes, never in a public issue.

## License

MIT or Apache-2.0, as you choose.
