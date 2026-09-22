import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Temporary: Task 2 deletes the smoke test and Task 3 writes the first real one, so the
    // tree has no test file for exactly one commit. Removed in Task 3.
    passWithNoTests: true,
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test.json",
    },
  },
});

export default config;
