/** Same theme Gemini wrote, now compiled ahead of time instead of loaded from a CDN. */
module.exports = {
  content: ['./index.html', './app.js', './crew.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['"Space Mono"', 'monospace'],
      },
      colors: {
        edge: {
          bg: '#F5F5F0',
          border: '#000000',
          acid: '#21FF00',
          cyan: '#00F0FF',
          pink: '#FF007A',
          purple: '#7000FF',
          yellow: '#FFE600',
          blueCoil: '#0055FF',
          dark: '#0A0A0C',
        },
      },
      boxShadow: {
        brutal: '4px 4px 0px #000000',
        'brutal-lg': '6px 6px 0px #000000',
        'brutal-sm': '2px 2px 0px #000000',
      },
    },
  },
  plugins: [],
};
