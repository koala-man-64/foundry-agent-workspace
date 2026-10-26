import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', '.claude/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  // These classic scripts are embedded into isolated WebView2 pages by the spike.
  { files: ['tests/Foundry.Spikes.BrowserSurface/Pages/*.js'], languageOptions: { sourceType: 'script', globals: { chrome: 'readonly', document: 'readonly', window: 'readonly', ResizeObserver: 'readonly', S4_NAME: 'readonly', s4Changed: 'readonly' } }, rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^setConfirmation$' }] } },
  // The renderer's first-paint script is a classic script copied as is (public/), so it runs before the module bundle.
  { files: ['apps/desktop/src/renderer/public/*.js'], languageOptions: { sourceType: 'script', globals: { document: 'readonly', window: 'readonly' } } },
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
