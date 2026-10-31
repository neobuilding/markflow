/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        // Single source of truth is globals.css `:root`/`.dark` --color-* custom properties.
        // v4 compiles `bg-accent` → `var(--color-accent)` and preserves `/alpha` via color-mix,
        // so keeping `accent.DEFAULT` as a bare var is the only colour entry we need here.
        // `accent-hover`/`accent-muted` and the whole `surface`/`border`/`text` blocks were
        // dead config (0 bare-tool-class hits — components use `bg-[var(--color-*)]` arbitrary values).
        accent: {
          DEFAULT: 'var(--color-accent)',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // 11px, not 10px: the smallest step anywhere in the UI must stay legible. This is a
        // GLOBAL token — every `text-2xs` in the app (sidebar, status bar, chips, dialogs)
        // moves up 1px with it. Compact spots that then truncate get fixed locally.
        '2xs': ['0.6875rem', '0.875rem'],
      },
      borderRadius: {
        // ADR-0024 §1.3: radius up one step. `DEFAULT` is the global `rounded` class, so it reaches
        // almost every container -- including the sidebar. The sidebar is exempted from DENSITY
        // only (its rows keep the 4/8px rhythm), NOT from the radius step.
        sm: '6px',
        DEFAULT: '8px',
        md: '10px',
        lg: '12px',
        xl: '14px',
      },
      boxShadow: {
        // Only `linear-lg` is actually referenced (dropdown-menu / dialog / context-menu / CommandPalette).
        // ADR-0024 §1.3: shadows softer and wider -- a `0 2px 8px` family instead of the old
        // `0 10px 15px -3px` / `0 4px 6px -2px` pair (which read as a hard drop shadow).
        'linear-lg': '0 2px 8px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)',
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-in-left': 'slideInLeft 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideInLeft: {
          '0%': { transform: 'translateX(-8px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(4px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
