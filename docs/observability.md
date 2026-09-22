# Observability

guideme emits OpenTelemetry spans and events and nothing else. It installs no provider, no
processor, no exporter and no context manager, writes to no file and logs nothing. The
application decides where the data goes.

What it emits is shaped by the OpenTelemetry semantic conventions: the GenAI conventions for
the ask span, the HTTP client conventions for each request, and the error conventions for
failures. Any OTLP backend, and any product that understands `gen_ai.*` attributes, reads it
without a mapping step.

## Shape

```
guideme.ask                      span, kind client, one per Guide.ask
├── POST /v1/systemone           span, kind client, one per HTTP attempt
│   └── guideme.retry            event, only when that attempt is about to be retried
└── guideme.answer               event, one per question
```

The ask span and the answer events come from the tracer named `guideme`; so do the HTTP spans
and the retry event, because a JavaScript package is one instrumentation scope and there is no
second name to give them. A batch of three questions is one ask span, one HTTP span if the
first attempt succeeds, and three answer events. A retried request is one ask span with
sibling HTTP spans, each with its own status code. `Guide.models` has no ask span of its own:
it emits a bare `GET /v1/models` span under whatever span the caller is in, one per attempt,
because that endpoint is retried on the same statuses as `POST /v1/systemone`.

**The parent-child shape needs a context manager, and installing one is the application's
job.** OpenTelemetry JS parents a span by the _active_ context, and the API's default context
manager never stores one. `NodeSDK` and `NodeTracerProvider` install
`AsyncLocalStorageContextManager` for you and are what almost every application uses;
`BasicTracerProvider` on its own does not, and under it every span is a root. This is also
what puts the ask span under the caller's own span, so it is the same mechanism in both
directions. `test/support/context.ts` is a thirty-line version of that manager, which is how
`test/tracing.test.ts` asserts the tree above without the package growing a dependency.

**The tracer is resolved per span, not once at import.** This package depends on
`@opentelemetry/api` `1.9.1` exactly, so an application that resolves any other version, or
whose installer does not deduplicate the two, has two copies of the API, and only one of them
is the one its `register()` reaches. A tracer taken at import time is a `ProxyTracer` bound to
this copy's own proxy provider and would stay a no-op for the life of the process — the
package would emit nothing at all, silently. `trace.getTracer` reads the registered provider
off `globalThis`, which both copies share, so taking it at span creation is what makes the
two-copy case work. `examples/otlp` is that case, and `test/tracing.test.ts` registers a fresh
provider per case, which is the same position and is what keeps this from regressing.

One limit is the API's, not this package's: a copy only accepts a global registered by the
same major and an equal or newer minor. An application whose own `@opentelemetry/api` is
`1.8` or older registers a global this package's `1.9.1` refuses, and its spans are dropped.

### Span `guideme.ask`

| Field                           | Type           | Meaning                                              |
| ------------------------------- | -------------- | ---------------------------------------------------- |
| `gen_ai.provider.name`          | string         | `typesafe`                                           |
| `gen_ai.operation.name`         | string         | `ask`                                                |
| `gen_ai.request.model`          | string         | alias or id sent, `jev-latest` by default            |
| `gen_ai.response.model`         | string         | versioned id that answered, for example `jev-1.13.0` |
| `gen_ai.usage.input_tokens`     | number         | billed tokens                                        |
| `gen_ai.usage.output_tokens`    | number         | free tokens                                          |
| `server.address`, `server.port` | string, number | where the request went                               |
| `guideme.questions`             | number         | questions in the request                             |
| `guideme.state.bytes`           | number         | UTF-8 **byte** length of the state JSON              |
| `guideme.state`                 | string         | the state JSON, only when `recordState: true` is set |
| `error.type`                    | string         | `GuidemeError.kind`, only when the ask failed        |

The span's kind is `SpanKind.CLIENT` and a failure sets the span status to
`SpanStatusCode.ERROR` with the message as its description. Rust carries those as the fields
`otel.kind`, `otel.status_code` and `otel.status_description`, because `tracing-opentelemetry`
reads those names to set them; here they are set natively and the exported span is identical.

`gen_ai.response.model` and `gen_ai.usage.*` are recorded when the response arrives, so they
are absent on a span that failed in transport. `guideme.state` is user data and is never
recorded unless asked for. `guideme.state.bytes` is bytes, not `String.prototype.length`,
which counts UTF-16 code units and would disagree with every other SDK on any non-ASCII
state. The API key appears in no field.

Two deliberate deviations from the GenAI conventions. The span keeps the name `guideme.ask`
rather than the `{operation} {model}` pattern: a fixed name is what dashboards key on, and the
model is on the span as an attribute. And `gen_ai.operation.name` is the custom value `ask`
rather than a well-known one such as `chat`: a Jev judgment sends structured questions and
gets probabilities back, and calling it a chat would make products that key on that value read
it as one.

### Spans `POST /v1/systemone` and `GET /v1/models`

| Field                           | Type           | Meaning                                                                                                 |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `http.request.method`           | string         | `POST` or `GET`                                                                                         |
| `server.address`, `server.port` | string, number | host and port of the base URL                                                                           |
| `url.full`                      | string         | the request URL; a base URL carrying credentials is rejected at build time so this never holds a secret |
| `url.template`                  | string         | `/v1/systemone` or `/v1/models`, the low-cardinality form of the path                                   |
| `http.request.resend_count`     | number         | ordinal of the retry, absent on the first attempt                                                       |
| `http.response.status_code`     | number         | absent when no response arrived                                                                         |
| `error.type`                    | string         | the status code as text on a non-200, otherwise `GuidemeError.kind`                                     |

The kind is `SpanKind.CLIENT`, and any non-200 status or transport failure sets the span
status to `SpanStatusCode.ERROR`.

A `429` that was retried and then succeeded is one failed attempt span next to one successful
one, exactly as the HTTP conventions describe a resend.

The HTTP conventions leave the status unset for a 3xx and let an instrumentation with more
context about the request set it more precisely. guideme has that context: its contract
defines `200` as the only success, this client does not follow redirects, and anything else
that reaches this code is returned as an error. So every non-200 marks the attempt. A 3xx
surfaces as `unexpected_status`; `docs/contract.md` records that Rust follows redirects and
this SDK does not, and `docs/design.md` records why.

### Event `guideme.answer`

| Field                                                             | Type             | Meaning                                                 |
| ----------------------------------------------------------------- | ---------------- | ------------------------------------------------------- |
| `guideme.question`                                                | string           | `q0..qN`, encounter order                               |
| `guideme.kind`                                                    | string           | `noul`, `choice` or `score`                             |
| `guideme.outcome`                                                 | string or number | `yes`/`no`/`unsure`, the chosen key, or the level index |
| `guideme.probability`                                             | number           | noul only, the probability of yes                       |
| `guideme.confidence`                                              | number           | choice and score, the reported confidence               |
| `guideme.value`                                                   | number           | score only, the expected value                          |
| `guideme.unsure`                                                  | boolean          | the policy's verdict                                    |
| `guideme.yes_above`, `guideme.no_below`, `guideme.min_confidence` | number           | the settled thresholds behind the verdict               |

The event is emitted from the resolved outcome, before the unsure ladder picks a fallback, so
it says what the model answered rather than what the caller ended up with.

### Event `guideme.retry`

Added to the failed attempt's span, just before the wait.

| Field                       | Type   | Meaning                                                         |
| --------------------------- | ------ | --------------------------------------------------------------- |
| `http.response.status_code` | number | `429` or `529`; absent when no response arrived                 |
| `error.type`                | string | `transport`; present only when no response arrived              |
| `guideme.retry.attempt`     | number | ordinal of the resend about to be made; `1` for the first retry |
| `guideme.retry.delay_ms`    | number | how long guideme is about to wait                               |

**Exactly one of `http.response.status_code` and `error.type` is present on every retry
event.** A response that was throttled carries its status; an attempt that never reached a
server — a refused or reset connection, a TLS handshake failure — has no status to report and
carries `error.type = "transport"` instead. Those are retried inside the same budget and with
the same backoff, because the request went nowhere. A timeout of any phase and a body failure
are not retried, so they never produce a retry event: they mark the attempt's span and are
returned. The rule is held by the compiler as well as by a test — the event's argument type is
a union of the two shapes, so an event with both or with neither cannot be constructed.

An injected `fetch` brings its own classification. guideme resends what `fetch` reports as a
`TypeError`, which is the connection phase; whatever your `fetch` throws for its own deadline
is retried or not according to that same rule. The attempt's own span is marked failed with
`error.type = "transport"` either way, as it already was for a transport failure that was not
retried.

### Errors

guideme never emits an error-level record of any kind. A failure is thrown as a typed
`GuidemeError` and marked on the span: `error.type` gets the stable name from
`GuidemeError.kind`, and the span status becomes `ERROR` with the message as its description.
That is what dashboards filter on, and it keeps the caller in charge of whether and where the
failure is logged.

`error.type` values on the ask span: `auth`, `invalid`, `rate_limited`, `overloaded`,
`transport`, `unexpected_status`, `protocol`, `unsure`, `config`. On an HTTP span it is the
status code as text on a non-200, otherwise one of those names — a `200` whose body failed to
read or decode is marked with `transport` or `protocol`, not with `200`.

The status description is the error's message, except for `invalid` and `unexpected_status`:
those errors carry the verbatim response body, which could echo the state, so the span only
says which status it was and the body stays on the thrown error.

Numbers are recorded as integers where the field is a count: OpenTelemetry attribute values
are `number`, and every count goes through `Math.trunc` so a backend that types them as `int`
never sees a fraction.

## Levels and filtering

There are no levels. OpenTelemetry JS has no per-span severity, so the Rust `RUST_LOG` matrix
has no counterpart: this package emits every span and event unconditionally, from one tracer
named `guideme`, and what reaches a backend is decided by the application's **sampler** and
its span processors.

| What you want                             | How                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------- |
| everything guideme emits                  | the default `AlwaysOnSampler`                                        |
| nothing                                   | `OTEL_TRACES_SAMPLER=always_off`, or install no provider at all      |
| a fraction                                | `OTEL_TRACES_SAMPLER=traceidratio` with `OTEL_TRACES_SAMPLER_ARG`    |
| guideme's spans and not another library's | a custom `Sampler` keyed on the instrumentation scope name `guideme` |

Installing no provider is the true off switch: the API's no-op tracer makes every span a
cheap object that goes nowhere.

## Console

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

One object per span close, with its attributes and its events. Remember the context manager:
with `BasicTracerProvider` alone the HTTP attempt spans print as roots rather than as children
of the ask span. `@opentelemetry/sdk-node`'s `NodeSDK`, or
`@opentelemetry/context-async-hooks`'s `AsyncLocalStorageContextManager` registered with
`context.setGlobalContextManager(..)`, is what gives you the tree.

## OTLP

`examples/otlp` is a runnable version of it: `NodeSDK` with an OTLP exporter, against the live
API, with a collector config that prints what it receives. It is its own package with its own
lock file, so its dependencies stay out of this one's tree.

### Configuration by environment

The JavaScript SDK reads the standard variables, so the example needs no change to point at a
different backend.

| Variable                                         | Effect                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                    | where to send; default `http://localhost:4317` for gRPC, `4318` for HTTP                       |
| `OTEL_EXPORTER_OTLP_HEADERS`                     | `key=value,key=value`, the usual place for a vendor's API key                                  |
| `OTEL_EXPORTER_OTLP_TIMEOUT`                     | milliseconds per export batch, default `10000`                                                 |
| `OTEL_EXPORTER_OTLP_COMPRESSION`                 | `gzip`                                                                                         |
| `OTEL_EXPORTER_OTLP_TRACES_*`                    | the same, for traces only; these win over the generic ones                                     |
| `OTEL_SERVICE_NAME`                              | `service.name` on every span                                                                   |
| `OTEL_RESOURCE_ATTRIBUTES`                       | `key=value,...`, for example `deployment.environment.name=prod,service.version=1.4.0`          |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `always_on`, `always_off`, `traceidratio`, `parentbased_traceidratio` with the ratio in `_ARG` |
| `OTEL_BSP_*`                                     | batch sizes and delays of the span processor                                                   |

### Where to point it

- **Look at the raw data.** Run the OpenTelemetry Collector with a debug exporter that prints
  every span it receives.

  ```sh
  docker run --rm -d --name guideme-otel -p 4317:4317 -p 4318:4318 \
    -v "$PWD/examples/otlp:/conf:ro" \
    otel/opentelemetry-collector-contrib:latest --config=/conf/collector.yaml
  docker logs -f guideme-otel
  ```

- **A UI on your laptop.** `grafana/otel-lgtm` is one container with an OTLP receiver, Tempo
  for traces, Loki for logs and Grafana in front.

  ```sh
  docker run --rm -d --name lgtm -p 3000:3000 -p 4317:4317 -p 4318:4318 grafana/otel-lgtm
  ```

- **A vendor.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` to their OTLP endpoint and put the API key
  in `OTEL_EXPORTER_OTLP_HEADERS`; their documentation names the header. Products with an LLM
  observability view pick the ask span up as a model call through its `gen_ai.*` attributes.

- **Metrics without instrumenting.** The collector's `spanmetrics` connector turns the spans
  into request, error and duration series, grouped by any attribute. Token cost per model is
  `sum(gen_ai.usage.input_tokens) by (gen_ai.response.model)` over the ask spans.

## Useful queries

- Cost per call: sum `gen_ai.usage.input_tokens` by `gen_ai.response.model`.
- Provider trouble: HTTP spans with `http.request.resend_count` set, or `guideme.retry` events
  per minute. Ask spans with `error.type` in `rate_limited`, `overloaded`, `transport` are the
  ones that gave up.
- Threshold tuning: on `guideme.answer`, the rate of `guideme.unsure=true` per
  `guideme.question`, next to the `guideme.min_confidence` recorded beside it. A band that is
  too wide shows up as reviewers drowning; too narrow shows up as wrong routes.
- Drift: `error.type=protocol` means the API's shape changed.
- One customer's ticket: the trace id links the ask span, its HTTP attempts and every answer,
  so a single trace view explains one decision end to end.

Every attribute name above is asserted by `test/tracing.test.ts`, which compares the whole
sorted key set of the ask span and of each answer event against a literal list. Adding a field
without adding it here fails the gate.
