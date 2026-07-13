import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// One vitest run covers both the Node API tests (test/**, default node env) and the React UI tests
// (ui/**, jsdom env). The react plugin transforms tsx; it's a no-op for the API's plain .ts files.
export default defineConfig({
  plugins: [react()],
  test: {
    environmentMatchGlobs: [["ui/**", "jsdom"]],
  },
});
