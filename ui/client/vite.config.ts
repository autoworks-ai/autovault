import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "ui/client",
  plugins: [react()],
  build: {
    outDir: "../../dist/ui/client",
    emptyOutDir: true
  }
});
