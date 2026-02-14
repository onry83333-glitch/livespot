/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'vip-gold': '#f59e0b',
        'vip-orange': '#f97316',
      },
    },
  },
  plugins: [],
};
