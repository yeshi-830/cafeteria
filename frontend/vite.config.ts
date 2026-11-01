import { fileURLToPath } from "node:url";
import { loadEnv, defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  const apiTarget = env.CAFETERIA_API_URL || `http://127.0.0.1:${env.PORT || 3000}`;
  const frontendPort = Number(env.VITE_PORT || 5173);

  return {
    root: frontendRoot,
    plugins: [tailwindcss()],
    server: {
      host: "127.0.0.1",
      port: frontendPort,
      strictPort: true,
      proxy: { "/api": { target: apiTarget } },
    },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
