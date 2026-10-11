import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/proxy/**/*.test.ts",
      "tests/frontend/**/*.test.ts",
      "tests/tooling/**/*.test.mjs",
    ],
    environment: "node",
    clearMocks: true,
  },
});
