import { defineConfig } from "vitest/config";
import path from "path";

// Pure protocol logic only (IMAP/MIME parsing, mail assembly) — no DOM needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
