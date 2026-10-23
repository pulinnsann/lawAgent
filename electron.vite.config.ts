import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), {
      name: 'contract-migration',
      buildStart() { for (const name of ['001-initial.sql', '002-official-sources.sql', '003-document-changes.sql', '004-editable-copy.sql', '005-contract-generation.sql', '006-enterprise-assurance.sql', '007-document-lifecycle.sql']) this.emitFile({ type: 'asset', fileName: `migrations/${name}`, source: readFileSync(`src/core/migrations/${name}`) }); },
    }],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'core-worker': resolve('src/main/core-worker.ts'), 'knowledge-worker': resolve('src/main/knowledge-worker.ts'), 'index-node': resolve('src/main/index-node.ts') } } },
  },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: 'cjs' } } } },
  renderer: { plugins: [react(), { name: 'dev-refresh-csp', transformIndexHtml(html, context) { return context.server ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") : html; } }] },
});
