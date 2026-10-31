import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'out',
      'dist',
      '**/dist',
      'release',
      'node_modules',
      'coverage',
      // Declaration files are generated or ambient (shims for untyped packages); there is no
      // code to judge. Everything else — including `*.config.ts` (vite / vitest / playwright /
      // postcss) and `*.config.cjs` — is linted: those files used to be ignored here and were
      // then covered by NO gate at all.
      '**/*.d.ts',
      'electron/main/jschardet-ultra.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The codebase intentionally uses `any` in a few interop/bridge spots.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Core ESLint 10 rule. It wants `new Error(msg, { cause })` for error chaining,
      // but TypeScript 7's bundled `Error` type no longer accepts a second options
      // argument, so the constructor form can't typecheck. Kept as a warning so the
      // intent stays visible without blocking the gate.
      'preserve-caught-error': 'warn',
      'no-undef': 'off',
      // Both rules come from eslint-plugin-react-hooks v7's React-Compiler-era presets. They
      // used to be pinned to `warn` so they would "surface without blocking the gate" — but
      // `lint` runs with `--max-warnings=0`, so a warning blocks the gate exactly like an
      // error would. That downgrade never bought any relief; it only hid the violations.
      // The flagged patterns are now fixed properly (derived state is computed during render,
      // never pushed in from an effect; refs are no longer written during render), so both
      // rules sit at `error` and act as regression guards.
      'react-hooks/refs': 'error',
      'react-hooks/set-state-in-effect': 'error',
    },
  },
  {
    // Node-side scripts and configs (CJS/ESM). They legitimately use Node globals
    // like `module`, `require`, `process`, `console`.
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  prettier,
)
