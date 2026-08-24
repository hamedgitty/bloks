import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Pinned to IPv4. Left to chance, "localhost" resolves to ::1 for
    // some clients and 127.0.0.1 for others, and the Electron window is
    // one of the ones that guesses wrong.
    host: "127.0.0.1",
    port: 5199,
    // Build output lives inside the repo, and watching it means every
    // package run reloads the browser mid-edit.
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // In development the app and the harness are two processes, so the
    // API is proxied to keep the browser on a single origin, exactly as
    // it is when packaged.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.BLOKS_PORT || 8799}`,
      },
    },
  },
});
