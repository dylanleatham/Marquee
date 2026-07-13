import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI lives in packages/curator/ui and builds to packages/curator/dist-ui, which Fastify serves
// in production. In dev, this server proxies /api and /healthz to the running Curator API (4739).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../dist-ui", emptyOutDir: true },
  server: {
    port: 4738,
    proxy: {
      "/api": "http://127.0.0.1:4739",
      "/healthz": "http://127.0.0.1:4739",
    },
  },
});
