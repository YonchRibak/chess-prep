// ESLint 9 flat config for apps/web.
//
// The devDependencies for this have been in package.json since Phase 0, but the
// config file itself was never written, so `pnpm lint` failed at the workspace
// root for every phase. Flat config is the only format ESLint 9 reads —
// `--ext` and `.eslintrc.*` are both gone, hence the `files` globs below and
// the plain `eslint .` in the package script.
//
// Deliberately NOT type-checked linting (`recommendedTypeChecked`): it needs a
// second full TS program on every run, and `pnpm typecheck` already covers
// everything type information would buy here.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    // Build output and generated files. `dist/` holds the bundled app plus the
    // vendored stockfish worker, which is minified third-party code.
    ignores: ['dist/**', 'dev-dist/**', 'public/**', 'coverage/**', '*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Fast Refresh only works when a module exports components alone. Warn,
      // not error: `ui.tsx` legitimately co-exports primitives and types.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // `_`-prefixed args are the project's "intentionally unused" convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Node context: config files run under Vite/Vitest, not in the browser.
    files: ['*.config.ts', 'vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
