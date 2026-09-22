# The OTLP example

One support ticket, three questions in one batch, and everything the SDK emits exported to an
OpenTelemetry Collector over OTLP/HTTP.

This is its own package with its own lock file. The root gate formats it and nothing else: the
root `tsconfig.json` includes only `src`, `test` and `vitest.config.ts`, and the root
`eslint.config.js` ignores `examples/**`. `mise run example` from the repository root is what
type-checks and lints it, and the `example` CI job runs that same task.

## Run it

```sh
# from the repository root, so the example has something to link against
bun install
mise run build

cd examples/otlp
bun install
```

Start a collector in one terminal:

```sh
otelcol --config collector.yaml
```

and the example in another:

```sh
TYPESAFE_API_KEY=… node --experimental-strip-types src/main.ts
```

It prints the three answers and the receipt:

```text
{ urgent: true, department: 'billing', mood: 'frustrated', atLeastFrustrated: true }
{ model: 'jev-1.13.0', inputTokens: 412, outputTokens: 18 }
```

The collector prints the trace. One `triage` span from this file, one `guideme.ask` span
beneath it, one `POST /v1/systemone` span beneath that per attempt, a `guideme.answer` event per
question, and two log records carrying the same trace and span ids.

Without a collector the example still runs and still prints its answers: a failed export is the
exporter's problem, not the program's.

## `--dry-run`

```sh
node --experimental-strip-types src/main.ts --dry-run
```

Calls no API and needs no key. It exports one span and one log record and exits, which is enough
to prove the wiring compiles and runs. That is the form the CI job uses.

## The endpoint

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` win if set;
otherwise `OTEL_EXPORTER_OTLP_ENDPOINT` with `/v1/traces` or `/v1/logs` appended; otherwise
`http://localhost:4318`.

## Why `register()` matters

`NodeTracerProvider.register()` installs the AsyncLocalStorage context manager. guideme runs
the body of an ask inside `context.with(..)`, which is how the HTTP attempt spans become
children of `guideme.ask` and how the whole ask lands under your own span. The API's default
context manager is a no-op that stores nothing, so **without** a context manager every span is
a root. The library installs none on purpose — that choice belongs to the application, and this
file is what making it looks like.

The log records are the application's own. guideme emits no log records; its telemetry is spans
and events on them. They are here because a record emitted inside the active span carries the
trace and span id, so the collector can show the line and the judgment together.
