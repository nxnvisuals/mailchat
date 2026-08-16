import type { Config } from "tailwindcss";

// Semantic tokens (border/background/muted/primary/…) backed by CSS variables
// in src/index.css, so components speak in roles rather than raw colors.
//
// Values are stored as raw oklch channels and wrapped here with the
// <alpha-value> placeholder, which is what keeps opacity modifiers such as
// bg-primary/10 and focus:ring-primary/40 working. Writing the variables as
// finished oklch(...) colours instead would silently break every one of them.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "oklch(var(--border) / <alpha-value>)",
        background: "oklch(var(--background) / <alpha-value>)",
        foreground: "oklch(var(--foreground) / <alpha-value>)",
        card: "oklch(var(--card) / <alpha-value>)",
        muted: {
          DEFAULT: "oklch(var(--muted) / <alpha-value>)",
          foreground: "oklch(var(--muted-foreground) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "oklch(var(--primary) / <alpha-value>)",
          foreground: "oklch(var(--primary-foreground) / <alpha-value>)",
          container: "oklch(var(--primary-container) / <alpha-value>)",
        },
        destructive: "oklch(var(--destructive) / <alpha-value>)",
        "surface-high": "oklch(var(--surface-high) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
