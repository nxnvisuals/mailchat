import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Standard Lovable-compatible Vite setup. `vite build` outputs a
// root-served site (what Lovable hosts); the Supabase-hosted copy is built
// separately by scripts/build-lite.mjs, which writes its own index.html
// with relative asset paths, so no special base is needed here.
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
}));
