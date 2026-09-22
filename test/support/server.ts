import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/** One request the server received, as the tests assert on it. */
export interface Received {
  /** Request path. */
  readonly path: string;
  /** Request method. */
  readonly method: string;
  /** Header map, lower-cased keys. */
  readonly headers: Readonly<Record<string, string>>;
  /** The raw body. */
  readonly body: string;
}

/** What a handler decides to send back. */
export type Reply =
  | { readonly status: number; readonly body?: string; readonly headers?: Record<string, string> }
  | { readonly hang: true }
  | { readonly cutMidBody: true };

/** A real local server on port 0, driven by a queue of replies. */
export interface TestServer {
  /** The origin to point a client at, with no trailing slash. */
  readonly baseUrl: string;
  /** Everything received, in order. */
  readonly received: readonly Received[];
}

/** The bound port, narrowed rather than asserted: `address()` is a three-way union. */
const portOf = (server: http.Server): number => {
  const address: string | AddressInfo | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server is not listening on a TCP port");
  }
  return address.port;
};

/**
 * Start a server that answers with `replies[i]` for the i-th request and repeats the last
 * reply forever after that. It closes itself when the test that started it finishes, pass or
 * fail, so no case carries a trailing `close()` that a failed assertion would skip.
 */
export const startServer = async (replies: readonly Reply[]): Promise<TestServer> => {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      received.push({ path: req.url ?? "", method: req.method ?? "", headers, body });
      const reply = replies[Math.min(received.length - 1, replies.length - 1)];
      if (reply === undefined) {
        res.writeHead(500).end();
        return;
      }
      if ("hang" in reply) return; // never respond; the client's own timeout must fire
      if ("cutMidBody" in reply) {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write('{"model":"jev-1.13.0","answers"');
        setTimeout(() => res.socket?.destroy(), 10);
        return;
      }
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  return { baseUrl: `http://127.0.0.1:${String(portOf(server))}`, received };
};

/** A port nothing listens on: bind it, read the number, then release it. */
export const closedPort = async (): Promise<number> => {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = portOf(server);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
};
