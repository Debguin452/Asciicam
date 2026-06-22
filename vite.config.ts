import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
   port: 5173,
   host: true,
   allowedHosts: true,
   hmr: {
      clientPort: 443,
    },
  },
 preview: {
    port: 4173,
    host: true,
  },
});
