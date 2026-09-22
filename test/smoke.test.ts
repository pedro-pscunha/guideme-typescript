import { expect, test } from "vitest";
import { CONTRACT_VERSION } from "../src/index.js";

test("the package builds and exports something", () => {
  expect(CONTRACT_VERSION).toBe("0.2.0");
});
