import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', '.claude/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { AbortController: 'readonly', DOMException: 'readonly' } } },
  // The renderer takes values only from the zod-free limits module, so its bundle carries no validator
  // (docs/wpf-webview2-migration.md, P0); protocol types stay available through `import type`.
  { files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{
    regex: 'packages/protocol/src/(?!limits$)',
    allowTypeImports: true,
    message: 'The renderer takes values only from packages/protocol/src/limits (zod-free); import protocol types with `import type`.'
  }] }] } }
);
