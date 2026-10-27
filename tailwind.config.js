/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#000000",
        paper: "#ffffff",
        blue: { DEFAULT: "#003cff", deep: "#002bb8" },
        ash: { 1: "#0d0d0d", 2: "#161616", 3: "#262626", 4: "#3d3d3d", 5: "#8a8a8a", 6: "#b5b5b5" },
      },
      fontFamily: {
        sans: ["Switzer", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
        gurmukhi: ["'Noto Sans Gurmukhi'", "sans-serif"],
      },
      letterSpacing: { tightest: "-0.055em" },
    },
  },
  plugins: [],
};
