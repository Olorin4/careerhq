import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--canvas)", surface: "var(--surface)",
        ink: "var(--ink)", muted: "var(--muted)", soft: "var(--soft)",
        line: "var(--line)", anchor: "var(--anchor)",
        "anchor-soft": "var(--anchor-soft)",
        info: "var(--info)", "info-soft": "var(--info-soft)",
        warn: "var(--warn)", "warn-soft": "var(--warn-soft)",
        ok: "var(--ok)", "ok-soft": "var(--ok-soft)",
        bad: "var(--bad)", "bad-soft": "var(--bad-soft)",
        irreversible: "var(--irreversible)",
      },
      boxShadow: { card: "var(--shadow)" },
      fontSize: {
        xs: "0.75rem", sm: "0.875rem", base: "1rem",
        lg: "1.125rem", xl: "1.3rem", "2xl": "1.5rem",
      },
    },
  },
} satisfies Config;
