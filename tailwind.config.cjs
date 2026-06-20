/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Linear-inspired color palette
        surface: {
          DEFAULT: '#f7f7f7',
          elevated: '#ffffff',
          overlay: '#f0f0f0'
        },
        border: {
          DEFAULT: '#e5e5e5',
          strong: '#d0d0d0'
        },
        accent: {
          DEFAULT: '#5e6ad2',
          hover: '#4f5abf',
          muted: '#eef0fb'
        },
        text: {
          primary: '#1a1a1a',
          secondary: '#6b6b6b',
          tertiary: '#9b9b9b',
          inverse: '#ffffff'
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace']
      },
      fontSize: {
        '2xs': ['0.625rem', '0.875rem']
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        md: '8px',
        lg: '10px',
        xl: '12px'
      },
      boxShadow: {
        'linear-sm': '0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.06)',
        'linear-md': '0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.04)',
        'linear-lg': '0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -2px rgba(0,0,0,0.04)',
        'linear-focus': '0 0 0 2px rgba(94, 106, 210, 0.3)'
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-in-left': 'slideInLeft 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out'
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        slideInLeft: {
          '0%': { transform: 'translateX(-8px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' }
        },
        slideUp: {
          '0%': { transform: 'translateY(4px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        }
      }
    }
  },
  plugins: []
}
