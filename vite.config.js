// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // EITHER of these works:
  base: './',                 // safest; makes assets relative (recommended)
  // base: '/Tick-And-Top/',  // or hard-code (must match repo name & case)
})
