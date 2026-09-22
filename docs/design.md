# Design

`@guideme/sdk` is a few modules behind one verb. Vocabulary used below: a **module** has an
**interface** and an **implementation**; a **seam** is where the interface lives; a module is
**deep** when a lot of behaviour sits behind a small interface.

## Seams

| Module                    | Interface                                                                                                                                           | What it hides                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Guide` (`guide.ts`)      | `ask(shape, state)`, `askWithReceipt`, `models()`, `withPolicy`, the options object                                                                 | request assembly, question-id minting, one span per request, per-answer events, policy precedence, decode of every shape                                  |
| `policy` (`policy.ts`)    | `resolve(answer, thresholds) -> Outcome`, `Policy` / `Thresholds`                                                                                   | threshold arithmetic for all three primitives, validation, ranking. Pure: no I/O, no generics, no classes. This is the function the shared contract pins. |
| `api/client.ts`           | `evaluate`, `models`                                                                                                                                | the only `fetch` call in the package, the auth header, retry with backoff and `retry-after`, status → `GuidemeError`, body decode                         |
| shapes (`ask.ts`)         | `Shape` and `Answered<S>` over a question, an `as const` tuple, an array, an object                                                                 | id assignment in encounter order, per-question settled thresholds, decoding back into the same shape                                                      |
| questions (`question.ts`) | `noul`, `choose`, `score`, `chooseAmong`, `scoreLevels`, `choice`, `levels`; `.with` / `.or` / `.detail` / `.criteria` and the threshold one-liners | wire encoding per primitive, rubric membership checks, `Outcome` → typed value, the unsure ladder                                                         |
| rubrics (`rubric.ts`)     | `option(what, parts)`, `level(what, parts)`, `fallback(what, parts)`                                                                                | the twelve legality rules and the one renderer                                                                                                            |
| scalars (`scalars.ts`)    | the five brands and their validators, `ApiKey`, `isBlank`, the three wire bounds                                                                    | validation done once, at the wire, and the redaction of the key                                                                                           |

## The deletion test

- Delete `policy` and threshold logic reappears in every caller, three times, and the shared
  contract disappears.
- Delete `ask` and batching reappears as one method per shape with id bookkeeping in each.
- Delete `api/client` and retry, backoff and `retry-after` reappear wherever the API is called.
- Delete `Guide` and span assembly, id minting and the precedence merge reappear at every call
  site.
- Delete `rubric` and the twelve rules reappear once per constructor, and drift.

Each module survives the test.

## Decisions

- **Questions are values.** `noul(..)`, `choose(D, ..)`, `score(L, ..)` need no `Guide`; build
  one once, store it, hand it to any guide. Every question object is frozen and every
  `.with` / `.or` / `.detail` returns a new one, so a stored question cannot be changed by the
  code that borrowed it.
- **One verb.** `guide.ask(shape, state)`. Question first, state second, so
  `if (await guide.ask(noul("…"), ticket))` reads with the judgment early.
- **Batching is the shape.** A tuple of questions is a question. So is an array and a plain
  object, and they nest. The answer has the same shape, from one request and one span, with
  ids `q0..qN` in encounter order.
- **`ask`'s type parameter carries no `const` modifier.** With it, every array argument would
  infer as a tuple and the array case would be unreachable; without it, `[q, q]` is
  `readonly boolean[]` and `[q, q] as const` is `readonly [boolean, boolean]`. Both are proved
  side by side in `test/typing.test-d.ts`. The caller says which they want, in the way
  TypeScript callers already say it.
- **Policy is a patch; thresholds are settled.** `Policy` has optional fields, so a house
  policy is a plain frozen object. Precedence: question > guide > defaults `0.5 / 0.5 / 0.0`.
  `Thresholds` is validated on construction and is what `resolve` and the golden vectors take.
- **The unsure ladder.** `.or(value)` beats the descriptor's `fallback` beats a typed `unsure`
  error. `.detail()` switches to `Verdict` / `Ranked<K>` / `Scored<K>` and never fails.
- **A detailed question has no `or`, and the compiler says so.** `detail()` returns its own
  interface — `DetailedNoulQuestion`, `DetailedChoiceQuestion<Out>`, `DetailedScoreQuestion<Out>`
  — which carries `with` and the threshold setters and nothing else. `readAnswer` dispatches on
  `detailed` before it looks at a fallback, so a value set after `.detail()` would be discarded
  without a word, and Rust says the same thing by not implementing `Fallible` for `Detailed<K>`.
  The three are re-exported from `src/index.ts`, with every other type a signature can reach, so
  a caller annotating a function names them instead of spelling `ReturnType<..>` or
  `Parameters<..>`, which would otherwise become the de facto API. They are parameterised by the
  **answer** rather than by the key, because that is the type argument `Answered` reads straight
  back off the reference.
- **A question's answer type is structural, and a question cannot be written by hand.** Every
  question interface carries `readonly [answer]: Out` (`DetailedNoulQuestion` carries
  `Verdict`), keyed by a `declare`d `unique symbol` that is never exported and never set at run
  time. Without it `Out` appeared only in `or`'s parameter — bivariant, as a method — and in
  recursive return types, so it was a free label: `DetailedChoiceQuestion<number>` held a real
  `.detail()`, and a choice over one key set passed for a choice over another. The member makes
  `Out` covariant, and through `detail()`'s return type it pins `K` too. It is **required**, so
  an object literal with every method of a question is a type error, as a hand-built descriptor
  already was: no caller can write the key. The three implementation classes `declare` the same
  member, type only. The runtime guard stays as the second line: `encodeQuestion` refuses
  anything that is not one of those classes with a `config` error, for a value that reached it
  through `unknown`.
- **Two rubric types where Rust has one.** Rust's `Rubric` is a single struct used in every
  rubric position, and "a level carries no counterexample" is a check inside `render_levels`
  plus a compile error inside `#[derive(Levels)]`. Here `option(..)` returns an `OptionRubric`
  and `level(..)` a `LevelRubric`, `LevelParts` has no `counterexamples` field, and every
  signature that takes a level takes the second type — so the rule is a type error at the call
  site on every path, which is the strengthening the goal asks for. The runtime check in
  `renderLevels` stays, for a value laundered through `unknown`. Nothing about which
  declarations are legal changed, which is what keeps the two SDKs one contract.
- **A runtime choice has two rungs.** `chooseAmong` answers a `Key` and there is no descriptor
  to hold a marked option, exactly as Rust's `impl Options for Key` names no fallback variant.
  A `fallback()` value handed to it is a `config` error rather than a silent no-op: a rung the
  caller believes they have and does not is worse than a refusal at the call site.
- **Score plain output is the argmax level.** `.detail()` exposes the API's expected `value`.
- **`levels()` does not generate an ordering operator.** Declaration order is level order, and
  the descriptor carries `index`, `compare`, `atLeast` and `rank`, so the two cannot disagree
  and no caller is tempted to compare the key strings with `>=`, which would be lexical.
- **No `rand` and no `Math.random`.** Backoff jitter comes from `crypto.getRandomValues`, which
  every supported runtime has natively.
- **Rubric examples are flattened into the rubric string, not sent as structured criteria.**
  Ported from guideme-rust, which measured it against live Jev on 2026-09-21: the API's
  structured `criteria` object is supported, and flattening is as good (score 1.01/1.01/1.01 at
  confidence 0.99 against 1.04/1.02/1.04 at 0.94 on the docs' own worked example) and cheaper
  (400 against 450 billed input tokens for the same content). The gain comes from the examples
  being present, not from the JSON structure. Do not re-litigate this here: the composition is
  a cross-SDK contract item and changing it changes every SDK at once.
- **Newline separation, no terminal punctuation.** Examples frequently end in `?`, and a
  space-joined format then needs a trailing `.` that produces `Where is my refund?.`. `what` is
  used verbatim, which is what makes a rubric with no examples render to itself byte for byte —
  and that is what makes the feature additive for anything written before it.
- **Telemetry speaks OpenTelemetry.** The ask span uses the GenAI conventions, each HTTP
  attempt is its own client span with the HTTP conventions, and a failure is `error.type` plus
  an error span status rather than an error-level record. Anything without a convention is
  namespaced `guideme.`. The package depends on `@opentelemetry/api` only and installs no
  provider; `docs/observability.md` shows the exporter side.

### The ones this SDK had to decide for itself

- **`fetch` injection is the transport seam, and there is no `Client` to hand in.** Rust
  exposes `reqwest` on its public surface so a caller can supply a proxy, a client certificate
  or a shared pool, and pays for it with a breaking change on every `reqwest` major. The
  JavaScript equivalent is already in the platform: `fetch` is a standard function type, so
  `new Guide({ fetch })` takes anything with that shape and puts **no library on the public
  surface at all**. A proxy is an `undici` `Agent` inside the caller's own `fetch`; a test
  double is a three-line function that returns a `Response`. `test/wire.test.ts` proves the
  injected one is the only transport used, with a spy on the global. The cost is that guideme
  cannot classify what a caller's `fetch` throws any better than it classifies the platform's,
  which `docs/contract.md` §2 states.
- **Retries classify by phase, never by error class or by `cause.code`.** Measured on Node
  22.23.2 and Bun 1.4.2:

  | Situation                    | Rejects with                        | Told apart by                         |
  | ---------------------------- | ----------------------------------- | ------------------------------------- |
  | refused or reset connection  | `TypeError`                         | the `await fetch(..)` rejecting       |
  | body truncated mid-stream    | `TypeError` — the same class        | the `await response.text()` rejecting |
  | `AbortSignal.timeout` firing | `DOMException` named `TimeoutError` | not a `TypeError`, so never resent    |
  | `AbortController.abort()`    | `DOMException` named `AbortError`   | the same                              |

  `retry-after` is read the same way — by naming the test rather than by reaching for the
  idiom. The whole trimmed value must match `/^\d+$/`; `Number.parseInt` reads `"3.5"` as `3`
  and `"1abc"` as `1` and would wait, where Rust's `u64::from_str` refuses both and falls back
  to the computed backoff. A date-format `retry-after` starts with a digit too, so a prefix
  parse honours part of a date as seconds.

  `instanceof TypeError` alone cannot tell a connection failure from a body failure, so the
  loop puts `fetch` and the body read in separate `try` blocks and only the first one resends.
  `cause.code` is not consulted: it is `ECONNREFUSED` on Node and **absent entirely** on Bun,
  so a rule written on it would be a rule that works on one runtime. `test/wire.test.ts` has a
  case for the truncated body precisely because a class check alone would get it wrong.

- **Redirects are not followed, and the shape of that differs in a browser.** A redirect
  carries the `Authorization` header and whether it survives a cross-origin hop is the
  runtime's rule, not this package's; `docs/contract.md` §6 states the policy. Every request
  is sent with `redirect: "manual"`. In Node that yields a real response carrying the 3xx
  status, so a redirect surfaces as `unexpected_status` with `status: 302`. In a browser it
  yields an _opaque-redirect_ response whose `status` is `0` and whose headers are empty, so
  the same redirect surfaces as `unexpected_status` with `status: 0`. Both are errors and
  neither follows the redirect, which is the property that matters; the status a caller sees
  differs and this sentence is where that is written down. `redirect: "error"` is **not** used:
  it rejects the `fetch` call with a `TypeError`, which is exactly the class the retry loop
  resends on, so a redirect would be retried to exhaustion and then reported as a transport
  failure.
- **No timeout of any phase is retried.** Ported from the contract, and the reason is the same
  in every language: `timeout` is the one number a caller sets to bound a call, and resending
  after a timeout multiplies the wall time that number promises. Here it is
  `AbortSignal.timeout` per attempt, so total wall time is bounded by
  `(maxRetries + 1) × timeout` plus the backoffs, and nothing else.
- **Every `zod` schema is module-private.** The schemas live in `src/api/wire.ts` and nothing
  outside that file imports them; `parseRequest`, `parseResponse` and `parseModels` are the
  only exports, and each returns a hand-written interface. No `z.infer` type is exported, so
  `zod` appears in no emitted declaration and a caller never resolves it. That keeps a `zod`
  major bump a patch here rather than a breaking change for everyone — the opposite of the
  trade Rust makes with `reqwest` — and it is checked twice: `test/typing.test-d.ts` pins
  `Receipt["usage"]` structurally, and the package proof greps `dist/index.d.ts` for `zod`.
- **`@opentelemetry/api` is a required peer; `zod` is a caret dependency.** The API is a
  process-wide singleton. As an exact regular dependency (`1.9.1`) it made two copies the
  normal case in an application, and an application on API `1.8` or older then got no spans
  and no warning. As a peer, the application's copy is the one this package uses, and an
  incompatible version is the installer's business: npm refuses the install (`ERESOLVE`) when
  the application's API does not satisfy `^1.9.0`; bun and pnpm warn, then use the
  application's copy. The peer is required, with no `peerDependenciesMeta`, because
  `src/telemetry.ts` imports the API at load and an absent optional peer would crash there.
  The floor is `1.9.0` and the dev copy is pinned there, so the gate tests the floor rather
  than whatever is newest. `zod` never reaches the public surface, so it stays a regular
  dependency, but a caret: an exact pin forces a second copy on every application that uses
  another 4.x. The lock pins what the gate builds; the non-required `latest-deps (unpinned)`
  job installs the newest `zod` 4.x and API 1.x over it and runs the suite, so a new release in
  range is tested before a user meets it.
- **The `util.inspect` hook is installed on `ApiKey.prototype`, not written in the class body.**
  `console.log` and `util.inspect` read `Symbol.for("nodejs.util.inspect.custom")`, and
  `Symbol.for(..)` does not produce a `unique symbol`, so `isolatedDeclarations` cannot name it
  as a computed class member: `error TS9038`. `Object.defineProperty` on the prototype, with
  `enumerable: false`, gives the same behaviour for every instance, keeps the key off
  `Object.keys`, and compiles. Redaction then holds for `String`, a template literal, `+`,
  `JSON.stringify`, `console.log` and `util.inspect` alike, which `test/redaction.test.ts`
  walks one view at a time.
- **TypeScript is pinned at 5.9.3, not 7.x.** `typescript-eslint@8.70.1` declares
  `peerDependencies.typescript = ">=4.8.4 <6.1.0"` and hard-throws on TypeScript 7:
  `Error: typescript-eslint does not support TS 7.0.`, exit 2, on **every** lint run. Installing
  TypeScript 7.0.2 also printed twelve incorrect-peer-dependency warnings. With 5.9.3 there are
  zero peer warnings and `eslint .` exits 0. The pin moves when typescript-eslint's peer range
  does, and not before.
- **`isolatedDeclarations` is on, with `declaration: true` and `noEmit: true` together.**
  Alone it is `error TS5069`. With all three, TypeScript 5.9.3 accepts it and still enforces
  it — `tsc --noEmit -p tsconfig.json` reports `error TS9007: Function must have an explicit
return type annotation` — so the type gate catches a missing annotation, not only the build.
- **`.fallowrc.json` declares project facts, and is not a baseline.** Without it, fallow
  reports every `src/index.ts` re-export as an unused export and every CLI-only devDependency
  as an unused devDependency, because the tasks that run them live in `mise.toml` where fallow
  cannot see them. Declaring `entry` and `ignoreDependencies` took the run from three dead
  files, five dead exports and two unused devDependencies to zero. The distinction is the whole
  point: a baseline records findings to forgive, and this records where the program starts and
  which packages are tools. Nothing is ever added to it to silence a true finding — a dead
  export is consumed or deleted, and a transient one is left failing until the task that
  consumes it lands.
- **`attw` runs on the `esm-only` profile.** `--profile strict` and `--profile node16` both
  exit 1 on a correct ESM-only package: node10 reports `NoResolution` and node16-cjs reports
  `CJSResolvesToESM`, and both are true statements about a package that deliberately ships no
  CommonJS. `--profile esm-only` ignores exactly those two resolutions and exits 0.
  `--ignore-rules no-resolution cjs-resolves-to-esm` also works; the profile is preferred
  because it names the intent instead of listing symptoms.

## Sharp edges

- **A batch is atomic.** One answer that resolves to an `unsure` or `protocol` error fails the
  whole call. Use `.or(..)`, a descriptor `fallback`, or `.detail()` on the questions that may
  be unsure — and on a runtime choice, `.or(..)` or `.detail()`, because there is no descriptor.
- **Ids are visible.** `q{n}` appears on the wire, in the `unsure` error and in
  `guideme.answer` events. They are positions in encounter order, nothing more — and for the
  object shape, `docs/contract.md` §5 says exactly what that order is.
- **`Key` and `Rank` are only meaningful through `chooseAmong` and `scoreLevels`.** A runtime
  choice answers with the key string, a runtime score with the level **index**, because Rust's
  `Rank` is a `usize`. Both brands are applied by the reader that already proved the value is
  in the rubric, which is why neither `key()` nor `rank()` validates anything.
- **`what` is never trimmed.** A rubric with no parts renders to itself byte for byte, for any
  string, and `test/policy-laws.test.ts` proves it over generated graphemes. That is what makes
  every declaration written before examples existed put the same bytes on the wire.
- **The blank, duplicate and line-break rules are three named primitives, not three idioms.**
  `String.prototype.trim()` is wrong in both directions, `split(/\r?\n/)` covers a different
  set than `includes("\n")`, and a normalised `Set` would refuse declarations the other SDKs
  accept. `docs/contract.md` §4 has the table.
- **The renderer lives once.** Rust has it twice because `Options::RUBRIC` is a `const`;
  TypeScript has no such constraint, so `render` in `src/rubric.ts` is the only copy and
  `choice()`, `levels()`, `chooseAmong()` and `scoreLevels()` all reach it. There is no pin
  test here because there is nothing to pin it to.
- **An example cannot belong to two options.** Saying so asserts the input is both, which
  cannot be true. The same string as an example of one option and a counterexample of another
  stays legal: that is the confusable-options pattern the feature exists for.
- **Rubric rules fire where the set is held.** Everything one rubric can see is checked in
  `render`; the rules that need more than one rubric in view are checked in `renderPair`,
  `renderOptions` and `renderLevels`, which every constructor calls, because every constructor
  here holds the whole set at once. A declaration is legal on every path or on none.
- **The answer event does not say whether a fallback was used.** It is emitted from the
  resolved outcome, before typed decoding runs the ladder. The settled thresholds are on the
  event, so "why unsure" is answerable.
- **`fromEnv` reads three variables, and an explicit option wins.** `TYPESAFE_API_KEY`,
  `TYPESAFE_BASE_URL` and `GUIDEME_MODEL`. When an override supplies the key, the environment
  is not read for it at all.
