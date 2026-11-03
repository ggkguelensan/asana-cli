import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.ASANA_SERVICE_URL;
if (target) {
  const url = new URL(target);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ASANA_SERVICE_URL must be a credential-free loopback HTTP origin');
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    ...(target ? { proxy: { '/api': { target, ws: true } } } : {}),
  },
  preview: { port: 4173, strictPort: true },
  build: { sourcemap: false },
});
