/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f5f7fb",
          100: "#e9eef7",
          200: "#d5dfef",
          500: "#2f5e9e",
          700: "#204677",
          900: "#132a47"
        }
      },
      boxShadow: {
        soft: "0 12px 32px rgba(19,42,71,0.08)"
      }
    }
  },
  plugins: []
};
