import noul from "../fixtures/noul.json" with { type: "json" };
import badNoul from "../fixtures/bad-noul.json" with { type: "json" };

/**
 * A docs fixture with its one answer re-keyed to `q0`, as JSON text.
 *
 * The docs fixtures key their answer by a name the caller chose (`is_urgent`), which is what
 * the wire allows; a `Guide` numbers its questions `q0..qN`, so a reply it can read has to use
 * that id. Derived here rather than kept as a second file, so the two cannot drift apart.
 */
const asQ0 = (fixture: { readonly answers: Readonly<Record<string, unknown>> }): string => {
  const answers = Object.values(fixture.answers);
  if (answers.length !== 1) throw new Error(`expected one answer, got ${String(answers.length)}`);
  return JSON.stringify({ ...fixture, answers: { q0: answers[0] } });
};

/** `fixtures/noul.json`, answered as `q0`: a yes at 0.95, 307 input tokens, 20 output. */
export const NOUL_AS_Q0: string = asQ0(noul);

/** `fixtures/bad-noul.json`, answered as `q0`: a noul probability of 1.5, out of range. */
export const BAD_NOUL_AS_Q0: string = asQ0(badNoul);
