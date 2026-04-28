import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: ['./tsconfig.json', './src/dashboard/tsconfig.json'],
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      // Rules added to eslint:recommended in ESLint 9/10 — downgraded to warn
      // to keep parity with the pre-bump baseline. Address opportunistically.
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
      // TypeScript handles undefined identifiers; ESLint can't see TS-only
      // type globals like `NodeJS.Timeout`, so we defer to tsc.
      'no-undef': 'off',
    },
  },
];
