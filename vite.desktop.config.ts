import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const dependencies = Object.keys(metadata.dependencies);
export default defineConfig({
  plugins: [{ name: 'desktop-migrations', buildStart() {
    for (const name of ['001-initial.sql', '002-official-sources.sql', '003-document-changes.sql', '004-editable-copy.sql', '005-contract-generation.sql', '006-enterprise-assurance.sql', '007-document-lifecycle.sql'])
      this.emitFile({ type: 'asset', fileName: `migrations/${name}`, source: readFileSync(`src/core/migrations/${name}`) });
  } }],
  build: {
    ssr: true, emitAssets: true, target: 'node24', outDir: 'out/desktop', emptyOutDir: true,
    rollupOptions: {
      input: { backend: resolve('src/desktop/index.ts'), 'core-worker': resolve('src/main/core-worker.ts'), 'knowledge-worker': resolve('src/main/knowledge-worker.ts') },
      external: id => id.startsWith('node:') || builtinModules.includes(id) || dependencies.some(name => id === name || id.startsWith(`${name}/`)),
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
    },
  },
});
