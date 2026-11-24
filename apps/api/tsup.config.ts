import { defineConfig } from 'tsup';

// Empacota o código dos pacotes internos (@multizap/*) e mantém as
// dependências de terceiros externas (resolvidas em node_modules).
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@multizap\//],
  external: [/^(?!@multizap\/)[^./]/],
});
