import { defineConfig } from 'tsdown'

export default defineConfig({
  target: 'node24',
  entry: ['src/index.ts', 'src/cli.ts'],
  tsconfig: './tsconfig.json',
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  treeshake: true,
})