import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  optimizeDeps: {
    include: ["desktop-note/store", "desktop-note/rich-text"],
  },
});
