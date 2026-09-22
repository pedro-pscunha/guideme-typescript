import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, context } from "@opentelemetry/api";
import type { Context, ContextManager } from "@opentelemetry/api";

/**
 * An `AsyncLocalStorage` context manager, which is what an application installs and this
 * package never does.
 *
 * OpenTelemetry JS parents a span by the **active** context, and the API's default manager is
 * a no-op that never stores one, so with no manager installed every span is a root. Node's own
 * `NodeTracerProvider` and `NodeSDK` install `AsyncLocalStorageContextManager` from
 * `@opentelemetry/context-async-hooks`; `BasicTracerProvider` does not. This is the same
 * mechanism in about thirty lines, so `test/tracing.test.ts` can assert the parent-child shape
 * `docs/observability.md` states without the package growing a dependency for it.
 */
class AsyncContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  /** The context of the current asynchronous execution, or the root. */
  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  /** Run `fn` with `ctx` active, for it and for everything it awaits. */
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(ctx, () => fn.call(thisArg, ...args));
  }

  /**
   * Not implemented, and loud about it. Nothing in this package or in these tests calls
   * `context.bind`, and a silent identity would make a future caller's spans quietly reparent.
   */
  bind<T>(ctx: Context, target: T): T {
    const where = ctx === ROOT_CONTEXT ? "the root context" : "a context";
    throw new Error(`bind() is not implemented: asked to bind a ${typeof target} to ${where}`);
  }

  /** Already usable; there is nothing to turn on. */
  enable(): this {
    return this;
  }

  /** Release the storage. */
  disable(): this {
    this.#storage.disable();
    return this;
  }
}

/** Install the context manager, as an application's tracing setup would. */
export const useAsyncContext = (): void => {
  context.setGlobalContextManager(new AsyncContextManager());
};
