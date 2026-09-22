# guideme working rules

Rules for anyone (or anything) changing this repository. Read fully before editing.

## What this is

A TypeScript package that makes a TypeSafe Jev judgment usable as control flow: a yes/no is an
`if`, a choice is an exhaustive `switch`, a score is a comparison. One package, published to
npm as `@guideme/sdk` under `MIT OR Apache-2.0`, ESM only.

The public surface is what `src/index.ts` re-exports, and nothing else: thirteen values and
twenty-three types. `test/surface.test.ts` pins the values, `test/typing.test-d.ts` pins the
types, and `scripts/check-exports.mjs` holds the built `dist/index.d.ts` to the list in
`scripts/exports.txt`, which is what notices a name being added. Anything removed or renamed in
either is a breaking change for people who do not work here, so it needs a major bump and a
`CHANGELOG.md` entry.

The live TypeSafe docs are the source of truth for the wire contract, over two pages:
`https://docs.typesafe.ai/api.md` covers `POST /v1/systemone` and
`https://docs.typesafe.ai/models.md` covers `GET /v1/models`. Re-read both before touching
`src/api/`.

## Layout and seams

| Path                | Owns                                                                                                                                                                                                                                                 | Rule                                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`      | **the only public surface**                                                                                                                                                                                                                          | re-exports and nothing else; no declaration of its own                                                                                                                                                                                                                                                             |
| `src/errors.ts`     | `GuidemeError`, `ErrorKind` (the nine names), the typed constructors, `assertNever`                                                                                                                                                                  | imports nothing                                                                                                                                                                                                                                                                                                    |
| `src/scalars.ts`    | the `Probability` / `Confidence` / `Model` / `Key` / `Rank` brands **and their validators**, `ApiKey`, the `isBlank` predicate that `rubric.ts` imports, the three wire bounds `MIN_LEVELS` / `MAX_LEVELS` / `MAX_OPTIONS`, and `compareByCodePoint` | imports only `./errors`. It is the leaf every other layer depends on, which is why those four things live here rather than where Rust puts them: `isBlank` refuses a blank key and a blank model as well as a blank rubric, and the bounds are needed by `resolve`, by `encodeQuestion` and by the schemas at once |
| `src/policy.ts`     | `Answer` — the hand-written input `resolve` takes — plus `resolve`, `Policy`, `Thresholds`, `Verdict`, `Outcome`, threshold merge and validation                                                                                                     | imports only `./errors` and `./scalars`. Pure: no I/O, no classes, no `fetch`, no telemetry. Its behaviour is the shared contract                                                                                                                                                                                  |
| `src/rubric.ts`     | `option` / `level` / `fallback`, the twelve legality rules, and **the renderer, once**                                                                                                                                                               | imports only `./errors` and `./scalars`. The `Answer` dependency runs from the wire toward the policy, never back                                                                                                                                                                                                  |
| `src/question.ts`   | the five question constructors, the two descriptors, the question methods, the unsure ladder, `encodeQuestion`, `readAnswer`                                                                                                                         | every rule the rubric layer enforces holds on every constructor, because every constructor here holds the whole set at once                                                                                                                                                                                        |
| `src/ask.ts`        | the shape mapper: question, `as const` tuple, array, plain object                                                                                                                                                                                    | ids are `q0..qN` in encounter order; `docs/contract.md` §5 says what that order is for an object                                                                                                                                                                                                                   |
| `src/api/wire.ts`   | the exact mirror of `POST /v1/systemone` and `GET /v1/models`, the module-private `zod` schemas, `parseRequest` / `parseResponse` / `parseModels`                                                                                                    | mirrors the docs field for field; no policy here; **no `z.infer` type leaves this file**                                                                                                                                                                                                                           |
| `src/api/client.ts` | HTTP, the 0.2.0 retry policy, status → `GuidemeError`, one HTTP client span per attempt and the `guideme.retry` event                                                                                                                                | **the only file in the package that calls `fetch`**. Span fields follow the OpenTelemetry HTTP client conventions                                                                                                                                                                                                  |
| `src/telemetry.ts`  | `trace.getTracer("guideme")` and every span, event and attribute name                                                                                                                                                                                | imports `@opentelemetry/api` and `./errors`; the names are what `docs/observability.md` records                                                                                                                                                                                                                    |
| `src/receipt.ts`    | `Receipt<T>`, `Usage`, `ModelInfo` — the public shapes, copied out of the wire types rather than derived from them                                                                                                                                   | imports only `./scalars`                                                                                                                                                                                                                                                                                           |
| `src/guide.ts`      | `Guide`, `Guide.fromEnv`, `ask`, `askWithReceipt`, `models`, `withPolicy`, the `guideme.ask` span and the `guideme.answer` events                                                                                                                    | one `guideme.ask` span per request, one `guideme.answer` event per question; span fields follow the OpenTelemetry GenAI conventions, anything else is namespaced `guideme.`                                                                                                                                        |

`docs/design.md` records the decisions and the sharp edges. Update it when a decision changes.

Telemetry is `@opentelemetry/api` only; the package installs no provider, no processor, no
exporter and **no context manager**. `docs/observability.md` records every field, and a change
to any of them must land there in the same commit — the names are part of the cross-SDK
contract. That document also records the one thing a reader must know before drawing the span
tree: parenting comes from the application's context manager, and under a bare
`BasicTracerProvider` every span is a root.

`examples/` holds runnable programs. Each is its own package with its own lock file, so the
gate formats but does not build them, and their dependencies stay out of the library's tree.

## Invariants

These hold everywhere in `src/` and, except where noted, in `test/` too. ESLint enforces most
of them; the rest are checked in review.

- **No `any`**, in `src/` or in `test/`. `@typescript-eslint/no-explicit-any` is an error, and
  `strictTypeChecked` refuses the unsafe operations that produce one by accident.
- **No `!` non-null assertion**, anywhere. `noUncheckedIndexedAccess` is on, so an indexed read
  is `T | undefined`; write the guard. A test that cannot narrow a value writes the guard too.
- **No `@ts-ignore`**, anywhere. `@ts-expect-error` is allowed **only** in
  `test/typing.test-d.ts`, only with a description, and only because an unused one is a
  failure there — which is what makes each of them evidence.
- **No `as` in `src/`** except `as const`. `no-restricted-syntax` flags every other form. Three
  sites carry an `eslint-disable-next-line` with the reason on the same line: the branded-scalar
  constructors in `src/scalars.ts`, and the one `decodeShape` cast in `src/guide.ts`, whose
  reason is that `Claim` erased the shape type by construction. A multi-line directive disables
  the wrong line; keep the reason on the directive line.
- **No `node:` imports in `src/`.** `import-x/no-nodejs-modules` is an error there. The package
  runs in any runtime with `fetch`. Tests may use `node:`; the port-0 server helper does.
- **`assertNever` in every `default` arm** over one of this package's own unions, never a
  silent fall-through. Where a `switch` would be too complex, a `Record` over the union is
  stronger, not weaker: a new member is a compile error at the table.
- **No silent substitution.** A `?? ""`, `?? []` or `?? 0` on an indexed read turns a missing
  value into a legal one. Iterate with `entries()` so there is no absent index, or throw a
  typed error. Fail loudly: unknown answer kind, option or level not in the rubric, malformed
  body, bad thresholds, empty batch — each is a typed `GuidemeError`, never a default and never
  a log-and-continue.
- **Raw JSON only in `src/api/`.** `unknown` appears on the public surface only as the `state`
  argument and as an `Instructions` object.
- **Probabilities and confidences are validated once, at the wire**, into `Probability` and
  `Confidence`.
- **The API key never prints.** `ApiKey` holds it in a `#private` field; `toString`, `toJSON`,
  `Symbol.toPrimitive` and the `util.inspect` hook all yield `ApiKey(***)`; `expose()` is
  called by `src/api/client.ts` and by nothing else.
- **State is user data.** Its content never reaches a span unless `recordState: true` was set;
  its length, `guideme.state.bytes`, always does, and it is **bytes**, not
  `String.prototype.length`.
- **Telemetry names are the contract.** They come from the OpenTelemetry semantic conventions
  where one exists (`gen_ai.*`, `http.*`, `server.*`, `url.*`, `error.type`) and are namespaced
  `guideme.` otherwise. Counts go through `Math.trunc`. A failure sets `error.type` and the span
  status and is thrown; no error-level record is ever emitted.
- **Every public item has TSDoc.** `isolatedDeclarations` is on, so every exported signature
  carries an explicit type, and `tsdoc/syntax` checks the comment grammar.
- **Dependencies stay minimal and pinned exact.** Two runtime dependencies, `zod` and
  `@opentelemetry/api`, and no carets anywhere. Adding one needs a reason in the commit message.

### The three rubric primitives, named

A prose rule whose wording matches a built-in's name will diverge, so each primitive is pinned
and the alternative that must never be used is named beside it.

| Primitive  | Use                                                                         | Never                                                          |
| ---------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| blank      | `isBlank`, a `\p{White_Space}` regex trim, defined once in `src/scalars.ts` | `String.prototype.trim()`                                      |
| duplicate  | `===` on the declared strings                                               | a `Set` of normalised keys, `localeCompare`, case folding, NFC |
| line break | `includes("\n") \|\| includes("\r")`                                        | `split(/\r?\n/)`, `/\s/`, `/\p{Cc}/`                           |

ECMAScript's `trim()` is wrong in **both** directions and that is why blank is pinned.
Measured: `"\u0085".trim().length` is `1` although U+0085 **is** `White_Space`, and
`"\uFEFF".trim().length` is `0` although U+FEFF is **not**. `U+2028` embedded in an item is
deliberately legal, which is what a `/\s/` or a `splitlines`-shaped rule would get wrong.

### Retry classification, named

By **phase**, never by error class and never by `cause.code`.

- `instanceof TypeError` on the **`fetch` rejection only**. That is the connection phase, and
  it is the only thing resent.
- `TimeoutError` and `AbortError` are `DOMException`, not `TypeError`, so this package's own
  `timeout`, in any phase, is never retried. Retrying it would multiply the wall time `timeout`
  promises. A connect timeout raised by the runtime's `fetch` itself — undici's, about 10 s —
  is different: it rejects as a `TypeError`, so it is a connection failure and is retried.
- A **body** failure is never retried, and it rejects with a `TypeError` too — measured on Node
  22.23.2 and Bun 1.4.2 — which is why the body read has its own `try` block. A class check
  alone gets this case wrong, and `test/wire.test.ts` has a row for it.
- `cause.code` is never inspected: `ECONNREFUSED` on Node, **absent entirely** on Bun.
- `429` and `529` are retried on **both** endpoints, honouring an integer `retry-after`, unless
  it is the last attempt or the header asks for more than 30 s.
- `retry-after` is **integer seconds or nothing**: the whole trimmed value against `/^\d+$/`,
  never `Number.parseInt`, which reads `"3.5"` as `3` and `"1abc"` as `1` where Rust's
  `u64::from_str` refuses both. Anything else is the absent case and the computed backoff
  applies.

## Policy semantics (do not change casually)

- Noul: `p >= yesAbove` is yes, `p <= noBelow` is no, strictly between is unsure. Defaults
  `0.5 / 0.5`.
- Choice and score: `confidence < minConfidence` is unsure. Default `0.0`.
- Precedence: question `.with(..)` and one-liners > guide (`policy`, `withPolicy`) > defaults.
- Unsure ladder: `.or(value)` > the descriptor's `fallback` > an `unsure` error. `.detail()`
  never fails, and has no `or` — `detail()` returns its own interface, so a value set after it
  is a compile error rather than a value the reader discards.
- A **runtime** choice has two rungs, not three: `.or(key)` then the error. `chooseAmong`
  refuses a `fallback()` value with a `config` error, because there is no descriptor to hold a
  marked option and Rust's `impl Options for Key` names no fallback variant.
- Score plain output is the argmax level; `.detail()` also exposes the API's expected `value`.
- A batch is atomic.

A change to any of these changes `spec/vectors/policy.json` and therefore every other SDK.
Bump the version, take the new `spec/`, and say so in `CHANGELOG.md`.

## Tests

Few tests, high grade. The ceiling is **40** vitest cases and the table below spends exactly 40. A `test.each` table counts as **one**. `test/typing.test-d.ts` is the typecheck file and is
outside the 40; row 40 is `#[ignore]`-equivalent and never runs in the gate.

A new case must be one of:

- a property test (`fast-check`) over a law of `resolve` or of the renderer;
- a wire or contract check through the `node:http` port-0 server in `test/support/server.ts`,
  asserting on received requests and typed results;
- a structural tracing assertion through `InMemorySpanExporter`, on attribute names and values;
- a type-level proof in `test/typing.test-d.ts`.

Never assert on log or inspected text, except to prove a secret is absent. Never mock `policy`
or `Guide`; the transport seam is `fetch` injection and a real local server, not a mock
library. The budget is a ceiling, not a target: a new case earns its place against this table,
usually by replacing a row rather than adding one.

<!-- The 40-case budget, copied verbatim from the plan. -->

| #   | File           | Case                                                      | Why this case exists                                                                                                                                                                                                                                                                                                                          |
| --- | -------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | policy-vectors | `test.each` over the 39 `outcome` vectors                 | SC1: deep equality against every golden outcome. One table, 39 rows.                                                                                                                                                                                                                                                                          |
| 2   | policy-vectors | `test.each` over the 3 `error: "protocol"` vectors        | SC1: `resolve` must throw `GuidemeError` with `kind === "protocol"`, not return a default.                                                                                                                                                                                                                                                    |
| 3   | rubric-vectors | `test.each` over the 10 rubric vectors                    | SC2: each rebuilt through the constructor its `kind` names, rendered, compared byte for byte.                                                                                                                                                                                                                                                 |
| 4   | rubric-vectors | absent clause vs `[]` vs no argument                      | SC2: `examples: []` is refused, no argument renders to `what` — the two must not be conflated.                                                                                                                                                                                                                                                |
| 5   | rubric-rules   | `test.each` of the refusals, 21 rows                      | SC3: the twelve rules, each with the contract sentence it pins; then seven of them again through a constructor (`choice`, `levels`, `chooseAmong`, `scoreLevels`, `noul().criteria()`), because "every rule holds on every path" is not proven by testing the renderer alone; then the two-fallback refusal and the runtime-fallback refusal. |
| 6   | rubric-rules   | the must-allow overlap is legal **and reaches the wire**  | SC3: example of one option = counterexample of another; asserts the rendered bytes, not just "no throw".                                                                                                                                                                                                                                      |
| 7   | rubric-rules   | a blank rubric with no parts is legal                     | SC3: the 0.1.0 compatibility guarantee.                                                                                                                                                                                                                                                                                                       |
| 8   | rubric-rules   | blank = Unicode `White_Space`                             | SC4: `U+0085` alone is blank, `U+FEFF` alone is not, and `String.prototype.trim()` disagrees with both.                                                                                                                                                                                                                                       |
| 9   | rubric-rules   | duplicate = `===`                                         | SC4: `"a"`/`" a"`/`"A"` are three different items; no trimming, no case folding, no NFC.                                                                                                                                                                                                                                                      |
| 10  | rubric-rules   | line break = `includes("\n") \|\| includes("\r")`         | SC4: `U+000A` and `U+000D` refused, `U+2028` legal and embedded.                                                                                                                                                                                                                                                                              |
| 11  | wire           | `test.each` over the three docs fixtures                  | SC5: the schemas accept the documented bodies and round-trip them.                                                                                                                                                                                                                                                                            |
| 12  | wire           | range and unknown-field behaviour                         | SC5: `1.5` and `-0.1` rejected at parse time; unknown response fields ignored.                                                                                                                                                                                                                                                                |
| 13  | wire           | `test.each`: 401 on both endpoints                        | SC9: `"auth"`, not retried, exactly one request served.                                                                                                                                                                                                                                                                                       |
| 14  | wire           | 422 carries the body                                      | SC9: `"invalid"`, body verbatim on the error.                                                                                                                                                                                                                                                                                                 |
| 15  | wire           | 429 with `retry-after: 1`                                 | SC9: retried after that delay, two requests.                                                                                                                                                                                                                                                                                                  |
| 16  | wire           | 429 with `retry-after: 3600`                              | SC9: fails at once, `retryAfterMs === 3_600_000`, one request.                                                                                                                                                                                                                                                                                |
| 17  | wire           | 529 exhausts the budget                                   | SC9: `"overloaded"` carrying `retryAfterMs`, `maxRetries + 1` requests.                                                                                                                                                                                                                                                                       |
| 18  | wire           | refused connection                                        | SC9: retried in the same budget, then `"transport"`.                                                                                                                                                                                                                                                                                          |
| 19  | wire           | timeout                                                   | SC9: **not** retried, one attempt, `"transport"`. The `TimeoutError` case.                                                                                                                                                                                                                                                                    |
| 20  | wire           | body closes mid-stream                                    | SC9: not retried — the case a `TypeError` check alone would get wrong.                                                                                                                                                                                                                                                                        |
| 21  | wire           | malformed body and an option outside the rubric           | SC9: both `"protocol"`.                                                                                                                                                                                                                                                                                                                       |
| 22  | wire           | unsure with no fallback, and an empty batch               | SC9: `"unsure"` naming the question; `"config"`.                                                                                                                                                                                                                                                                                              |
| 23  | wire           | the receipt                                               | SC10: `askWithReceipt` returns the response's `model` and `usage` exactly.                                                                                                                                                                                                                                                                    |
| 24  | wire           | `ask` returns the bare answer for every shape             | SC10: question, tuple, array, object.                                                                                                                                                                                                                                                                                                         |
| 25  | wire           | injected `fetch` is the only transport                    | SC11: a spy proves the global `fetch` is never called; the README recipe is the input.                                                                                                                                                                                                                                                        |
| 26  | tracing        | the `guideme.ask` span's attribute set                    | SC12: exactly the documented names, including `gen_ai.response.model` and `gen_ai.usage.*`.                                                                                                                                                                                                                                                   |
| 27  | tracing        | one HTTP child span per attempt                           | SC12: `http.request.resend_count` absent on the first, present from the second.                                                                                                                                                                                                                                                               |
| 28  | tracing        | `test.each`: one `guideme.answer` event per question kind | SC12: noul, choice and score field sets.                                                                                                                                                                                                                                                                                                      |
| 29  | tracing        | failure marks the span                                    | SC12: `error.type` and the span status `ERROR` with its description; no error event.                                                                                                                                                                                                                                                          |
| 30  | tracing        | state is user data                                        | SC12: `guideme.state` absent unless `recordState: true`; `guideme.state.bytes` always.                                                                                                                                                                                                                                                        |
| 31  | tracing        | `test.each`: the `guideme.retry` exclusivity rule         | SC12: exactly one of `http.response.status_code` / `error.type` on 429 and on a refused connection.                                                                                                                                                                                                                                           |
| 32  | redaction      | every string view of `ApiKey` and `Guide`                 | SC13: `String`, template, `JSON.stringify`, `util.inspect`, `Symbol.toPrimitive`.                                                                                                                                                                                                                                                             |
| 33  | redaction      | the key is on no span attribute                           | SC13: scans every attribute of every span and event.                                                                                                                                                                                                                                                                                          |
| 34  | redaction      | the `Authorization` value is in no error                  | SC13: walks the whole `cause` chain and the stack.                                                                                                                                                                                                                                                                                            |
| 35  | policy-laws    | noul monotonicity and the open band                       | SC14: `fast-check` — monotone in `p` and in both thresholds; unsure iff strictly inside.                                                                                                                                                                                                                                                      |
| 36  | policy-laws    | choice unsure and `ranked` ordering                       | SC14: unsure iff `confidence < minConfidence`; descending probability, ties by key.                                                                                                                                                                                                                                                           |
| 37  | policy-laws    | score argmax with ties to the lowest                      | SC14: over random distributions.                                                                                                                                                                                                                                                                                                              |
| 38  | policy-laws    | the load-bearing renderer invariant                       | SC14: for **any** string, a rubric with no parts renders to itself byte for byte.                                                                                                                                                                                                                                                             |
| 39  | surface        | `Object.keys(sdk)`                                        | The `__all__` test: the thirteen runtime exports, sorted, and nothing else.                                                                                                                                                                                                                                                                   |
| 40  | live           | `test.each` of the two live tests                         | SC18: skipped unless `TYPESAFE_API_KEY` **and** `LIVE=1`.                                                                                                                                                                                                                                                                                     |

The table is the plan's, copied across, with one change: case 5's refusal table is **21** rows
rather than 20, and its reason names the fourteenth. A `fallback()` value handed to
`chooseAmong` is refused, which the plan did not anticipate and `docs/contract.md` §8 states.
The number of **cases** is unchanged, because a `test.each` table counts as one.

The live tests in `test/live.test.ts` hit the real API and are skipped unless both variables
are set:

```
TYPESAFE_API_KEY=… LIVE=1 bun run vitest run test/live.test.ts
```

## Commands

```
mise run check      # the gate: fmt-check, lint, types, readme, fallow, test, build, surface,
                    #   publint, attw, audit
mise run readme     # every ts block in README.md is compiled by a test, line for line
mise run surface    # after build: dist/index.d.ts exports exactly scripts/exports.txt, no zod
mise run example    # type-check and lint examples/otlp (needs its own bun install and dist/)
mise run test       # vitest, including the typecheck file
mise run test-bun   # the suite under the Bun runtime (the `bun` CI job)
mise run secrets    # gitleaks over the whole history (the `secrets` CI job)
mise run min-node   # build, then import dist/ on the running node (the `min-node` CI job)
mise run lint       # eslint only; a warning or an unused disable directive fails it
mise run types      # tsc --noEmit over src and test
mise run fallow     # dead code, duplication and health; zero findings, no baseline
mise run spec-check # fail if the vendored spec/ has drifted from guideme-rust main
mise run hooks      # activate the tracked git hooks in .githooks (see below)
```

The gate runs cheapest first and stops at the first failure, so a formatting mistake never
costs a full test run. Run everything from the repository root. Capture long output to a file;
do not pipe a gate through `tail`.

`fallow` must report **zero** findings across all three analyses — dead code, duplication and
health — with no baseline and no new `ignoreDependencies` entry. `.fallowrc.json` carries the
entry points and exactly ten CLI-tool names, and it is not a place to forgive a true finding:
a dead export is consumed or deleted.

## Git

- Branch from `main`, open a pull request, squash-merge. `main` takes pull requests only: a
  GitHub ruleset requires every check below to pass before a merge, and refuses direct pushes.
- The seven required checks, by name:

  ```
  gate (22)    gate (lts/*)    bun    secrets    example    min-node    spec-drift
  ```

- CI runs the same gate on two Node versions and under Bun, scans the whole history with
  `gitleaks`, builds and lints `examples/otlp`, proves the package builds on the minimum
  supported Node, and diffs the vendored `spec/` against guideme-rust `main`. A weekly run
  re-checks the advisory database and the spec drift. CI holds no secrets and never runs the
  live tests. `.github/dependabot.yml` is what moves the SHA-pinned actions forward.
- The hooks are tracked in `.githooks/` and do nothing until you run `mise run hooks`, which
  points this repository's `core.hooksPath` at that directory and fails, leaving nothing
  changed, if the result is not active. Git reads one hooks directory and a repo-local
  `core.hooksPath` outranks a global one, so these fire even where you have a global hooks
  directory — which also means a global secret-scanning hook stops running here, and is why
  these hooks scan for secrets themselves.
- `pre-commit`: `gitleaks` on the staged change, then `mise run fmt-check` and `mise run lint`.
  `pre-push`: `gitleaks` over every range git reports as being pushed, so a branch other than
  the checked-out one is scanned too, then `mise run check` when a branch with content is
  pushed. A delete or a tag-only push runs no gate.
- Every tool a hook needs is resolved loudly. A missing `gitleaks` or `mise` refuses the commit
  or the push; no hook ever skips a check because a binary was not on `PATH`. A scanner that
  fails to run is reported as that, not as a finding.
- `--no-verify` skips a hook. Two known limits are not escape hatches but read like them: the
  gate inspects the working tree, not the index or the pushed commit, so a partial `git add -p`
  is checked against the files on disk; and a checkout of a commit older than `.githooks/` has
  no hooks at all. CI on every pull request is the backstop for both.
- Commit messages: imperative subject under 72 characters, body says why. **No trailers, no
  tool attributions, no generated-by lines.**
- Never commit an API key, a `.env`, or anything under `.tmp/`.

## Changing the contract

1. Read the current TypeSafe API and models pages.
2. Change `src/api/wire.ts` to mirror them. Add or update the docs-example fixture under
   `test/fixtures/`.
3. If the change reaches `policy`, update `resolve`, the property tests, and `docs/contract.md`.
4. Take the new `spec/` from guideme-rust and update `spec/SOURCE` to the commit it came from;
   `mise run spec-check` is what proves the copy is clean. `spec/` is **never** edited here.
5. `mise run check`.
6. Note it in `CHANGELOG.md`.

Changing how a rubric renders is a contract change too: the composition is shared with every
other SDK, so it goes through `docs/contract.md`, the vendored `spec/vectors/rubric.json` and
`CHANGELOG.md`. The clause labels and the declaration ordering are part of it. A rubric with no
examples and no counterexamples must keep rendering to itself, byte for byte; that invariant is
what makes every declaration written before the feature put the same bytes on the wire, and
`test/policy-laws.test.ts` proves it over generated strings.

So is changing **which** rubric declarations are legal. Here the rules are one set enforced
once, in `src/rubric.ts`, because every constructor holds the whole set at once — unlike Rust,
where the derives reject at expansion time and the runtime rejects at ask time. Adding or
relaxing one of them means `docs/contract.md` and an issue in every other SDK: a rubric must be
legal in all of them or in none.

Renaming, adding or removing a span or event field is also a contract change: it goes through
`docs/observability.md`, `docs/contract.md` and `CHANGELOG.md`, and is announced the same way.
`spec/` is unaffected. `test/tracing.test.ts` compares whole sorted attribute-key sets against
literal lists, so a field added without being documented fails the gate.

## Releasing

One package, `@guideme/sdk`, ESM only, published with provenance from the release workflow.

**A published version is effectively permanent.** npm allows unpublishing only in a narrow
window and never for a version others depend on, so a fix ships as a new version and the
affected one is deprecated. Get the gate green before publishing, not after.

1. Bump `version` in `package.json`.
2. Move the `Unreleased` notes in `CHANGELOG.md` under the new version with today's date.
3. `mise run check`, then commit and push.
4. `git tag -a vX.Y.Z` and push the tag; the release workflow publishes from it.
5. Check the published package: `npm view @guideme/sdk@X.Y.Z`, and that `dist/index.d.ts`
   mentions no `zod`.

No dependency is on the public surface and none should join one. `fetch` injection is what
keeps it that way: `GuideOptions.fetch` takes `typeof globalThis.fetch`, a platform type, so a
caller never resolves a library of ours. Rust pays a major bump for `reqwest` being on its
surface; this package pays nothing, and `docs/design.md` records the trade.

Breaking the observability field names or the policy semantics is a contract change; see above
before bumping.

## Other SDKs

Each guideme SDK lives in its own repository and is written from scratch in its own language.
guideme-rust publishes the shared contract under `spec/` and states it in its
`docs/contract.md`; this repository vendors that `spec/` and records the commit in
`spec/SOURCE`. A drift job fails when the copy falls behind, so a contract change lands there
first and the job is what tells this repository to catch up.

| Language   | Repository                                                                        |
| ---------- | --------------------------------------------------------------------------------- |
| Rust       | [`pedro-pscunha/guideme-rust`](https://github.com/pedro-pscunha/guideme-rust)     |
| Python     | [`pedro-pscunha/guideme-python`](https://github.com/pedro-pscunha/guideme-python) |
| TypeScript | this repository                                                                   |
