// Developer tool: requires the repository's installed dev dependencies. Build only the
// shipping provider entry in memory, without loading application/Vite configuration.
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';

let adapter;
export function loadQualificationProvider() {
  return adapter ??= import('vite').then(async ({ build }) => {
    const result = await build({
      configFile: false,
      envFile: false,
      publicDir: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: fileURLToPath(new URL('../packages/providers/src/index.ts', import.meta.url)), formats: ['es'] },
        rollupOptions: { external: [/^node:/] }
      }
    });
    const output = Array.isArray(result) ? result[0]?.output : result.output;
    const chunks = output?.filter(item => item.type === 'chunk');
    if (chunks?.length !== 1 || output.length !== 1) throw new Error('Qualification provider must build into one self-contained module.');
    return import(`data:text/javascript;base64,${Buffer.from(chunks[0].code).toString('base64')}`);
  });
}
