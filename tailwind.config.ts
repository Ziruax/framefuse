import type { Config } from "tailwindcss";

// Tailwind 4 uses the CSS-first config in src/app/globals.css
// (@import "tailwindcss" + @theme). This JS config only remains as a
// fallback for tooling that still reads it — no plugins required.
const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
};
export default config;
