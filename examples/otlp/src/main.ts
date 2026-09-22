/**
 * Triage one support ticket with guideme and export the whole thing over OTLP.
 *
 * Run `docker compose`-less, with any collector listening on 4318:
 *
 *     otelcol --config collector.yaml &
 *     TYPESAFE_API_KEY=… node --experimental-strip-types src/main.ts
 *
 * `--dry-run` calls no API and needs no key. It exports one span and one log record, which is
 * what the `example` CI job runs.
 */
import { logs } from "@opentelemetry/api-logs";
import { trace } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { Guide, choice, choose, fallback, level, levels, noul, option, score } from "@guideme/sdk";

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: "guideme-otlp-example",
  [ATTR_SERVICE_VERSION]: "0.0.0",
});

// `register()` is what installs the AsyncLocalStorage context manager. guideme runs its ask
// body inside `context.with(..)`, so without a context manager every HTTP attempt span would
// be a root instead of a child of `guideme.ask`. The library installs nothing on purpose; an
// application is the thing that owns that choice, and this is what owning it looks like.
// The exporters take no `url`: they read the standard `OTEL_EXPORTER_OTLP_*` variables
// themselves and fall back to http://localhost:4318.
const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
tracerProvider.register();

// guideme emits no log records — its telemetry is one span per ask, one span per HTTP attempt
// and events on them. This pipeline carries the *application's* records, which is the point:
// emitted inside the active span, each one carries the trace and span id the ask is under, so
// a collector can put the log line and the judgment side by side.
const loggerProvider = new LoggerProvider({
  resource,
  processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
});
logs.setGlobalLoggerProvider(loggerProvider);

const tracer = trace.getTracer("guideme-otlp-example");
const logger = logs.getLogger("guideme-otlp-example");

const Department = choice({
  billing: option("Payments, invoicing, refunds", {
    examples: ["My card was charged twice", "Where is my refund?"],
    counterexamples: ["The dashboard is down"],
  }),
  technical: option("Bugs, outages, integrations", { examples: ["502 on every request"] }),
  sales: fallback("Pricing, upgrades, new accounts"),
});

const Frustration = levels({
  calm: "Calm and polite",
  frustrated: level("Frustrated", { examples: ["this is the third time I'm writing"] }),
  veryAngry: "Very angry",
});

const ticket = "My card was charged twice and nobody has answered me in three days.";

// A failed export is the exporter's problem, not the program's: the answers are already
// printed and the judgment already happened. Without this the ECONNREFUSED from a collector
// that is not running becomes an unhandled rejection and takes the process down after it has
// done its work, which would make a telemetry endpoint a dependency of the triage.
const flush = async (): Promise<void> => {
  const quietly = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (e) {
      console.log(`${what} failed (${String(e)}); is a collector listening on the OTLP endpoint?`);
    }
  };
  await quietly("trace export", () => tracerProvider.forceFlush());
  await quietly("log export", () => loggerProvider.forceFlush());
  await quietly("tracer shutdown", () => tracerProvider.shutdown());
  await quietly("logger shutdown", () => loggerProvider.shutdown());
};

const triage = async (): Promise<void> => {
  const guide = Guide.fromEnv();
  await tracer.startActiveSpan("triage", async (span) => {
    try {
      logger.emit({ severityText: "INFO", body: "triaging a ticket", attributes: { ticket } });

      const { answer, model, usage } = await guide.askWithReceipt(
        [
          noul("Is this ticket urgent?").yesAbove(0.7).noBelow(0.3).or(false),
          choose(Department, "Which team should handle this?").minConfidence(0.6),
          score(Frustration, "How frustrated is the customer?"),
        ] as const,
        ticket,
      );
      const [urgent, department, mood] = answer;

      console.log({
        urgent,
        department,
        mood,
        atLeastFrustrated: Frustration.atLeast(mood, "frustrated"),
      });
      console.log({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

      logger.emit({
        severityText: "INFO",
        body: "triaged",
        attributes: { urgent, department, mood, model, "usage.input_tokens": usage.inputTokens },
      });
    } finally {
      span.end();
    }
  });
};

if (process.argv.includes("--dry-run")) {
  console.log(
    "dry run: exporting one span and one log record, and exiting without calling the API",
  );
  await tracer.startActiveSpan("dry-run", async (span) => {
    logger.emit({ severityText: "INFO", body: "dry run", attributes: { ticket } });
    span.end();
    await Promise.resolve();
  });
  await flush();
} else {
  await triage();
  await flush();
}
