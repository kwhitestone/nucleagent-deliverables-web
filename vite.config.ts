import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.DELIVERABLES_WEB_PORT ?? env.PORT ?? 26628);
  const host = env.DELIVERABLES_WEB_HOST ?? "0.0.0.0";
  const backendUrl = env.DELIVERABLES_BACKEND_URL ?? "http://localhost:26620";
  const shellOrigin = new URL(env.VITE_SHELL_URL ?? "http://localhost:26600").origin;
  return {
    plugins: [vue()],
    resolve: {
      dedupe: ["vue", "vue-router"],
      alias: {
        "@prism-fusion/plugin-runtime/remote": resolve(
          process.cwd(),
          "src/vendor/prism-fusion-plugin-runtime/remote.ts",
        ),
        "@prism-fusion/plugin-runtime/types": resolve(
          process.cwd(),
          "src/vendor/prism-fusion-plugin-runtime/types.ts",
        ),
        "@prism-fusion/plugin-runtime": resolve(
          process.cwd(),
          "src/vendor/prism-fusion-plugin-runtime/headless.ts",
        ),
 "@": resolve(process.cwd(), "src") },
    },
    server: {
      host,
      port,
      cors: true,
      headers: {
        "Content-Security-Policy": `frame-ancestors ${shellOrigin}`,
        "X-Content-Type-Options": "nosniff",
      },
      proxy: {
        "/api": { target: backendUrl, changeOrigin: true },
      },
    },
  };
});
