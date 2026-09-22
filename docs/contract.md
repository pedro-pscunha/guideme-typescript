# The guideme contract

Every guideme SDK is written from scratch in its own language. What they share is a contract,
and this repository is not where it is published. It lives in
[guideme-rust](https://github.com/pedro-pscunha/guideme-rust): the statement is
[`docs/contract.md`](https://github.com/pedro-pscunha/guideme-rust/blob/main/docs/contract.md)
and the machine-readable half is that repository's `spec/`. Read it there. Its three parts are
wire fidelity, policy conformance and interface shape, and this package satisfies all three.

`spec/` here is a copy of `spec/` there, and `spec/SOURCE` holds the guideme-rust commit it
was taken from. `spec/schema/*.json` are the shapes of `POST /v1/systemone`, which the wire
models validate against on the docs examples. `spec/vectors/policy.json` is the 42 golden
vectors, every one of which is a row of `test/policy-vectors.test.ts`: an entry with an
`outcome` must equal it by deep equality, an entry with `error: "protocol"` must throw a
`GuidemeError` whose `kind` is `"protocol"`. `spec/vectors/rubric.json` is the ten rubric
cases, each rebuilt through the constructor its `kind` names and compared byte for byte.
Nothing in `spec/` is edited here. A behaviour difference between this package and another SDK
is either a bug here or an ambiguity to resolve upstream; it is never fixed by changing the
copy.

Drift is caught rather than trusted. `mise run spec-check` clones guideme-rust, diffs its
`spec/` against this one and fails on any difference except `spec/SOURCE`, which is provenance
and has no counterpart upstream. `AGENTS.md` has the procedure for taking a new `spec/`.

What follows is only what is specific to this SDK.

## 1. Two absences the language forces

**No synchronous `ask`.** There is no synchronous `fetch`, in any JavaScript runtime, so there
is nothing to build one on. Python ships two guides because its ecosystem is genuinely split;
JavaScript's is not, and every caller is already in an `async` function or at a top-level
`await`.

**No `close()` and no `Symbol.dispose`.** `fetch` owns no connection pool this package
controls, so there is nothing to release. One `Guide` per process, shared freely: `ask` holds
no state between calls.

## 2. An injected `fetch` and `timeout` do not conflict

Rust refuses `timeout(..)` beside `http(..)` at build time, with a config error, because a
`reqwest::Client` carries its own deadline and two deadlines over one request is a setting
that quietly does nothing.

An injected `fetch` carries none. `timeout` here is an `AbortSignal.timeout` passed as the
request's `signal` on every attempt, and a `fetch` implementation that honours `signal` —
which the platform one does, and any reasonable stand-in does — is bound by it unchanged. So
there is nothing to refuse, and `new Guide({ fetch, timeout })` is a supported combination
rather than a config error. A `fetch` that ignores `signal` is outside what this package can
promise, and so is a `fetch` that imposes a second deadline of its own.

## 3. The telemetry spelling

`otel.kind`, `otel.status_code` and `otel.status_description` are span _fields_ in Rust,
because `tracing-opentelemetry` reads those names to set the exported span's kind and status.
In JavaScript they are not fields at all: the kind is `SpanKind.CLIENT` passed to
`startSpan`, and the status is `span.setStatus({ code: SpanStatusCode.ERROR, message })`. The
exported span is identical, which is the point — a backend cannot tell the two SDKs apart.
`docs/observability.md` carries the full field tables.

## 4. Three implementations of "blank", and only two agree

"Blank" is Unicode `White_Space`. The three languages' idiomatic trims do not all say that, so
this SDK names the primitive rather than describing it: `isBlank` in `src/scalars.ts` is a
`\p{White_Space}` regex trim, and `String.prototype.trim()` is forbidden by name.

| Implementation                       | Code points removed                                    | Agrees with the contract   |
| ------------------------------------ | ------------------------------------------------------ | -------------------------- |
| Rust `str::trim`                     | exactly `White_Space`                                  | yes                        |
| this SDK's `\p{White_Space}` regex   | exactly `White_Space`                                  | yes                        |
| Python `str.strip()`                 | `White_Space` plus the C0 separators `U+001C`–`U+001F` | a documented superset      |
| ECMAScript `String.prototype.trim()` | keeps `U+0085`, removes `U+FEFF`                       | **no, in both directions** |

ECMAScript is the only one that is wrong both ways, which is why the primitive is pinned
rather than left to the idiom. Measured: `"\u0085".trim().length` is 1 although U+0085 _is_
`White_Space`, and `"\uFEFF".trim().length` is 0 although U+FEFF is _not_.
`test/rubric-rules.test.ts` pins both.

The other two primitives are named the same way. A duplicate is `===` on the declared strings,
never a `Set` of normalised keys and never `localeCompare`. A line break is
`includes("\n") || includes("\r")`, never `split(/\r?\n/)`, never `/\s/`, never `/\p{Cc}/`:
those cover different sets and would leave two SDKs disagreeing about `U+2028`, which is
deliberately legal.

## 5. `q0..qN` and what encounter order means for an object

Ids are assigned in encounter order in every SDK. What differs is what "encounter order" is
for the object shape.

Here it is `Object.keys` order, which puts integer-like keys first in ascending numeric order
and every other key in insertion order. Rust sorts, because its map is a `BTreeMap`. So
`{ b: …, a: … }` is `q0` for `b` and `q1` for `a` here, and the other way round there; and
`{ "2": …, "10": …, "a": … }` is `"2"`, `"10"`, `"a"` here, and `"10"`, `"2"`, `"a"` there.

The JSON object that carries the ids is therefore in insertion order here and sorted there.
The API keys its answers by id and observes neither, so nothing on the wire depends on it —
but a caller reading ids out of an error message or a span event will see this SDK's order,
and that is why it is written down.

An array and an `as const` tuple have one obvious order and every SDK uses it.

## 6. This client does not follow redirects; the Rust client does

`docs/observability.md` in guideme-rust records that redirects are followed there, so this is
a real divergence and not a language constraint: `fetch` follows them by default and would
have matched.

It is a **policy choice**. A redirect carries the `Authorization` header, and whether it
survives a cross-origin hop is the runtime's rule rather than this package's. The API contract
defines `200` as the only success and every other status as an error, so a redirect is not a
case this package needs, and the cost of getting it wrong is the key reaching a host the
caller never named. Every request is sent with `redirect: "manual"` and a 3xx surfaces as
`unexpected_status`. `test/wire.test.ts` asserts that the host named by a `location` header
receives nothing.

A guideme service that began redirecting would need this decision revisited in both SDKs at
once, which is why it is written down here rather than left in the client.

## 7. The span tree needs a context manager, and the package installs none

`docs/observability.md` draws each HTTP attempt span as a child of the ask span, and that is
what this SDK emits — provided the application has installed an OpenTelemetry context manager.
OpenTelemetry JS parents a span by the active context, and the API's default manager never
stores one, so under a bare `BasicTracerProvider` every span is a root.

`NodeSDK` and `NodeTracerProvider` install one; almost every real setup therefore has it. The
same mechanism is what puts the ask span under the caller's own span, so a package that
side-stepped it to force the parenting would break the direction that matters more. Rust and
Python need no equivalent step, because `tracing` and `contextvars` carry the active span for
them.

## 8. The unsure ladder for a runtime choice has two rungs, not three

The contract states one ladder: the question's own fallback value, then the alternative marked
as the fallback, then a typed `unsure` error. For a **runtime** choice the middle rung does not
exist in any SDK — Rust's `choose_among` answers a `Key`, and `impl Options for Key` names no
fallback variant, so there is nothing for a marked option to be.

This SDK **refuses** a `fallback()` value handed to `chooseAmong`, with a `config` error naming
the rule, rather than accepting it and ignoring it. The reading is that a rung the caller
believes they have and does not is worse than a refusal at the call site: `fallback("…")` reads
as a setting, and a setting that silently does nothing is the failure mode the whole package is
written against. `scoreLevels` needs no equivalent, because a level has no fallback to mark.

The rung that does exist is `.or(key)`. `test/rubric-rules.test.ts` carries the refusal as row
14 of its table.

## 9. Three things this SDK holds with the compiler that the others hold with a test

Not divergences — the same contract, checked earlier.

**A missing `switch` arm.** `choice({..})` returns a descriptor whose key union is the answer
type, so a `switch` over it with an arm missing leaves a value that is not `never`, and
`assertNever` in the `default` arm is a compile error. The README shows the three lines that
define `assertNever`; it is not exported, because the public surface is thirteen values and it
belongs in the caller's code.

**The `guideme.retry` exclusivity rule.** The contract says exactly one of
`http.response.status_code` and `error.type` is present on a retry event. The event's argument
type is a union of the two shapes rather than two optional fields, so an event with both or
with neither cannot be constructed.

**A detailed question has no unsure rung.** `.detail()` skips the ladder, so a fallback set
after it would be discarded without a word. Rust says this by not implementing `Fallible` for
`Detailed<K>`; here `detail()` returns its own interface, carrying `with` and the threshold
setters and no `or`, so `noul("…").detail().or(x)` does not compile. Those three interfaces are
not on the public surface — a caller meets one only as the return type of `detail()` — so the
surface stays at thirteen values and twenty-three types.
