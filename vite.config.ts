import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: { manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined) },
    },
  },
});
