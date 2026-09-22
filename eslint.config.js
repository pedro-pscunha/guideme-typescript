// @ts-check
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import tsdoc from "eslint-plugin-tsdoc";

export default defineConfig(
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
      // that cannot narrow a value writes the guard, exactly as src does.
      "tsdoc/syntax": "off",
    },
  },
);
