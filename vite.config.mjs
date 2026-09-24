import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'ui/approval-test',
  plugins: [viteSingleFile()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'ui/approval-test/approval-test.html',
    },
  },
});
