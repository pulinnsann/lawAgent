import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), {
    name: 'tauri-csp',
    transformIndexHtml(html) { return html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/u, ''); },
  }],
  build: { outDir: '../../out/tauri-renderer', emptyOutDir: true, target: ['safari15', 'chrome105'] },
});
