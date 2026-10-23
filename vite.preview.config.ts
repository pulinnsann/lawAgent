import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ root: 'src/renderer', plugins: [react(), { name: 'dev-refresh-csp', transformIndexHtml(html, context) { return context.server ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") : html; } }], server: { port: 5173 } });
