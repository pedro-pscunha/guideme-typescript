import { expect, test } from "vitest";
import * as sdk from "../src/index.js";

test("the package exports exactly these thirteen values and nothing else", () => {
  // A module namespace carries VALUES only, because types are erased; `test/typing.test-d.ts`
  // holds the other half, where the types are named.
  //
  // Sorted before comparing, because the key ORDER is the host's, not this package's.
  // Measured: Node's real namespace object for `dist/index.js` comes back sorted by UTF-16
  // code unit, and the same import under vitest comes back in export-declaration order,
  // because vite transforms the module into a plain object rather than a namespace. The names
  // are the contract; which of the two orders the runtime happens to use is not.
  expect([...Object.keys(sdk)].sort()).toEqual([
    "ApiKey",
    "Guide",
    "GuidemeError",
    "choice",
    "choose",
    "chooseAmong",
    "fallback",
    "level",
    "levels",
    "noul",
    "option",
    "score",
    "scoreLevels",
  ]);
  expect("default" in sdk).toBe(false);
  // Every one is callable or constructible; nothing is an accidental re-export of an object.
  for (const [name, value] of Object.entries(sdk)) {
    expect(typeof value, `${name} must be a function or a class`).toBe("function");
  }
});
