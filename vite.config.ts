import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  // BB serves the dashboard under its plugin route, so that build needs a base.
  base: process.env.SKILL_GATEWAY_UI_BASE ?? "/",
  plugins: [svelte({ configFile: new URL("./svelte.config.js", import.meta.url).pathname })],
  root: "src/ui",
  build: {
    outDir: process.env.SKILL_GATEWAY_UI_OUT ?? "../../dist/ui",
    emptyOutDir: true,
  },
});
