// @ts-check
// The root eslint.config.js ignores examples/** — the example is its own package, with its own
// lock file and its own tsconfig, and the root type-aware config cannot resolve its imports.
// This is its config; `mise run example` and the `example` CI job both run it.
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({
  files: ["**/*.ts"],
  extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
  languageOptions: {
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/consistent-type-imports": "error",
    // An example is a program, not a library: printing is what it is for.
    "no-console": "off",
  },
});
