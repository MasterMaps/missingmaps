import { defineConfig } from 'vite'

// GitHub Pages serves this repo from https://mastermaps.github.io/missingmaps/
export default defineConfig({
  base: process.env.BASE_PATH ?? '/missingmaps/',
  build: { outDir: 'dist', sourcemap: true },
})
