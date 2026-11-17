import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'src',
  base: './',
  // Le paquet monaco-editor n'exporte que des modules .js : l'alias donne accès à ses contributions et feuilles CSS.
  resolve: { alias: { 'monaco-esm': path.join(here, 'node_modules/monaco-editor/esm/vs') } },
  // Pas de pré-bundle de Monaco en développement : l'optimiseur ne sait pas traiter son worker importé « ?worker&inline ».
  optimizeDeps: { exclude: ['monaco-editor', 'monaco-esm'] },
  server: { host: '127.0.0.1', strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 6000 },
});
