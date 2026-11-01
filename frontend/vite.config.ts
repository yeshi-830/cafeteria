import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const apiTarget = process.env.CAFETERIA_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

export default defineConfig({
  root: frontendRoot,
  plugins: [tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: apiTarget } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
