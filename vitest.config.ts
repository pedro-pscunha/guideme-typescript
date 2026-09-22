import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every `vi.spyOn` is undone after its case, so no case has to remember to do it.
    restoreMocks: true,
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test.json",
    },
  },
});

export default config;
