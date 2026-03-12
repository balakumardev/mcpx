import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  splitting: false,
  sourcemap: true,
  define: {
    '__PKG_VERSION__': JSON.stringify(pkg.version),
  },
});
