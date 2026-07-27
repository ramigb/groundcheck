import { defineConfig } from 'vite'

// The fixture is never actually served; this file exists so the repo looks and
// resolves like a real Vite + React project to the slice builder.
export default defineConfig({
  build: { outDir: 'dist' },
})
