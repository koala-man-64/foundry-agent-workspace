import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', '.claude/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { AbortController: 'readonly', DOMException: 'readonly' } } }
);
