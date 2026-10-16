import { defineConfig } from 'vite';

export default defineConfig({
  // Relative assets work at both / and a GitHub project-page /repository/ path.
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
