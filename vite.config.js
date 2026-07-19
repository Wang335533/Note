import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  optimizeDeps: {
    include: ["desktop-note/store"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@lezer/")) return "markdown-parser";
          if (id.includes("/node_modules/@codemirror/")) {
            return "markdown-engine";
          }
          return undefined;
        },
      },
    },
  },
});
