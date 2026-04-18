import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans:    ["Syne", "ui-sans-serif", "system-ui", "sans-serif"],
        mono:    ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        display: ["Syne", "sans-serif"],
      },
      colors: {
        emerald: {
          DEFAULT: "#10b981",
          400: "#34d399",
          500: "#10b981",
          600: "#059669",
          900: "#064e3b",
          950: "#022c22",
        },
      },
      animation: {
        "fade-in":  "fadeIn 0.4s ease forwards",
        "slide-up": "slideUp 0.35s cubic-bezier(0.16,1,0.3,1) forwards",
        "blink":    "blink 1.2s ease-in-out infinite",
        "ping-slow":"pingSlow 2s ease-out infinite",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to:   { opacity: "1" },
        },
        slideUp: {
          from: { opacity: "0", transform: "translateY(12px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0.3" },
        },
        pingSlow: {
          "0%":       { transform: "scale(1)",   opacity: "0.8" },
          "70%, 100%":{ transform: "scale(2.2)", opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
