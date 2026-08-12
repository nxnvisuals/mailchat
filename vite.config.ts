import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// In production the app is served by the Supabase `app` edge function at
// /functions/v1/app/, so assets need that base. Dev server stays at /.
export default defineConfig(({ mode }) => ({
  base: mode === "development" ? "/" : "/functions/v1/app/",
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
}));
