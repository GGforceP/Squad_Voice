import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), {
    name: 'desktop-csp',
    transformIndexHtml(html) {
      if (command === 'serve') return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
      if (mode !== 'qa') return html.replace(' http://127.0.0.1:* ws://127.0.0.1:*', '');
      return html;
    },
  }],
  base: './',
  build: { target: 'es2022', sourcemap: false, license: true },
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
}));
