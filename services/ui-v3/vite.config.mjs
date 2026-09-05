import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/ui-v3/",
  build: {
    outDir: "dist/client",
    rollupOptions: {
      output: {
        manualChunks: {
          "canvas-vendor": ["@xyflow/react", "zustand", "zundo"],
          "icons-vendor": ["@phosphor-icons/react"]
        }
      }
    }
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", "127.0.0.1", "localhost"],
    proxy: {
      "/v1": "http://127.0.0.1:8090",
      "/media": "http://127.0.0.1:8090"
    },
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react()],
});
