import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
export default defineConfig({
  root: "app",
  plugins: [
    react(),
    {
      name: "build-identity",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { name: "app-build", content: sha },
          injectTo: "head",
        },
      ],
    },
  ],
  build: { outDir: "../dist", emptyOutDir: true, sourcemap: false },
});
