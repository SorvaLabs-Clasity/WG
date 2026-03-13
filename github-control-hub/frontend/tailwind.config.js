/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        gh: {
          dark: '#24292f',
          light: '#f6f8fa',
          bg: '#f6f8fa',
          border: '#d0d7de',
          text: '#1F2328',
          textBase: '#24292f',
          muted: '#656d76',
          textMuted: '#57606a',
          blue: '#0969da',
          blueHover: '#0353a4',
          green: '#1a7f37',
          red: '#cf222e',
          'hover-gray': '#f3f4f6',
          canvas: '#f6f8fa',
          nav: '#24292f',
        },
        github: {
          dark: '#24292f',
          light: '#f6f8fa',
          border: '#e1e4e8',
          hover: '#f3f4f6',
          primary: '#0969da',
          secondary: '#57606a',
        },
        status: {
          public: '#1a7f37',
          publicBg: '#dafbe1',
          private: '#9a6700',
          privateBg: '#fff8c5',
        }
      },
      boxShadow: {
        'soft': '0 3px 6px -1px rgba(140, 149, 159, 0.15)',
        'lift': '0 8px 18px -2px rgba(140, 149, 159, 0.15)',
        'subtle': '0 1px 3px rgba(31, 35, 40, 0.12), 0 8px 24px rgba(149, 157, 165, 0.05)',
        'floating': '0 3px 6px rgba(140, 149, 159, 0.15)',
        'card': '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)',
        'modal': '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04), 0 0 0 1px rgba(0,0,0,0.05)',
        'input-focus': '0 0 0 3px rgba(9, 105, 218, 0.3)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out forwards',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'shine': 'shine 1s infinite',
        'gradientBG': 'gradientBG 15s ease infinite',
        'fadeInUp': 'fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'fadeInDelayed': 'fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'pulse-once': 'highlightPulse 2s ease-out forwards',
        'slide-in-right': 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'scale-in': 'scaleIn 0.2s ease-out forwards',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        highlightPulse: {
          '0%': { backgroundColor: 'rgb(219 234 254 / 0.6)' },
          '30%': { backgroundColor: 'rgb(219 234 254 / 0.6)' },
          '100%': { backgroundColor: 'transparent' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shine: {
          '100%': { transform: 'translateX(100%)' }
        },
        gradientBG: {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' }
        },
        fadeInUp: {
          to: {
            opacity: 1,
            transform: 'translateY(0)'
          }
        },
        slideInRight: {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        }
      }
    },
  },
  plugins: [],
}
