import type { Model } from "./scalars.js";

/** Tokens read and written. Input tokens are the billed ones. A frozen plain object. */
export interface Usage {
  /** Tokens read. Billed. */
  readonly inputTokens: number;
  /** Tokens written. Free. */
  readonly outputTokens: number;
}

/** One entry from `GET /v1/models`. */
export interface ModelInfo {
  /** Name or alias accepted by the `model` field. */
  readonly name: Model;
  /** What it is for. */
  readonly description: string;
  /** Release date as the API reports it. */
  readonly releaseDate: string;
}

/** An answer with what the request cost and which model produced it. */
export interface Receipt<T> {
  /** The answer, in the shape that was asked for. */
  readonly answer: T;
  /** The versioned model that answered, for example `jev-1.13.0`, even when an alias was sent. */
  readonly model: Model;
  /** Tokens read and written. */
  readonly usage: Usage;
}
