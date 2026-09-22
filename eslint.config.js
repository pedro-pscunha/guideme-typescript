// @ts-check
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import tsdoc from "eslint-plugin-tsdoc";

// A `.catch` whose callback takes no parameter has thrown the failure away before anyone could
// read it. Shared by the two blocks below that set `no-restricted-syntax`, because a later block
// replaces the rule's options rather than adding to them.
const swallowedCatch = {
  selector:
    "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression)[params.length=0]",
  message:
    "A .catch callback that takes no parameter discards the failure. Name it and carry it: as a cause, a typed error, or a value that says what went wrong.",
};

export default defineConfig(
  // An unused suppression is a stale claim about the code, so it fails like any other finding.
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  globalIgnores([
    "dist/**",
    "node_modules/**",
    "coverage/**",
    "examples/**",
    "spec/**",
    "eslint.config.js",
  ]),
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { tsdoc, "import-x": importX },
    rules: {
      "tsdoc/syntax": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false },
      ],
      // Fail loudly: an empty block or body is where a failure goes to be forgotten.
      "no-empty": "error",
      "@typescript-eslint/no-empty-function": "error",
      "no-restricted-syntax": ["error", swallowedCatch],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "import-x/no-nodejs-modules": "error",
      // Every `as` in src is an error except `as const`. Measured against nine forms: the
      // rule allows `as const` and `satisfies`, allows a site carrying the disable below, and
      // flags `n as Probability`, `raw as Thing`, `x as unknown as Y` (twice, once per cast),
      // `x as string`, `x as readonly string[]` and `<string>x`. A selector that excluded
      // TSTypeReference would allow every named-type cast, which is the whole population.
      "no-restricted-syntax": [
        "error",
        swallowedCatch,
        {
          selector: "TSAsExpression:not([typeAnnotation.typeName.name='const'])",
          message:
            "No `as` casts in src except `as const`. A branded-scalar constructor may use one with an eslint-disable-next-line naming the check that proves the invariant.",
        },
        {
          selector: "TSTypeAssertion",
          message: "No angle-bracket type assertions. Use `as const`, or a type guard.",
        },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // The only relaxation tests get. `tsdoc/syntax` checks the grammar of doc comments and
      // a test file has no published API to document; every other rule stays on, because the
      // Invariants say no `!` and no unsafe member access ANYWHERE, not only in src. A test
      // that cannot narrow a value writes the guard, exactly as src does — `noulOutcome`,
      // `choiceOutcome` and `scoreOutcome` in test/policy-laws.test.ts and `portOf` and
      // `questionsOf` in test/ are what that looks like. The `as` expressions that remain in
      // test/ are neither narrowing nor assertion: two declare the shape of an imported JSON
      // vector file, and one builds a value the type system forbids, through `unknown`, to
      // hand a runtime constructor the input only a JavaScript caller could reach it with.
      "tsdoc/syntax": "off",
    },
  },
);
