import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-electron',
      'release',
      'node_modules',
      'coverage',
      '**/*.config.ts',
      '**/*.config.js',
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
      // These two rules are very new (eslint-plugin-react-hooks v6) and flag patterns
      // the codebase uses deliberately: writing the latest value into a ref during render
      // (to avoid stale closures) and resetting component state when an effect runs.
      // They are kept as warnings so they surface without blocking the build.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
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
