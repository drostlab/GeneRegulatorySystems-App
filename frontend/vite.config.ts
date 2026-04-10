import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { copyFile, mkdir, access } from 'fs/promises'

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'copy-scichart-wasm',
      async buildStart() {
        const publicDir = path.resolve(__dirname, 'public')
        const dest = path.resolve(publicDir, 'scichart2d.wasm')
        await access(dest).catch(async () => {
          await mkdir(publicDir, { recursive: true })
          const source = path.resolve(__dirname, 'node_modules/scichart/_wasm/scichart2d.wasm')
          await copyFile(source, dest)
          console.debug('Copied scichart2d.wasm to public/')
        })
      }
    }
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    include: ['scichart']
  },
  // Tauri expects a fixed port; clearScreen off so Rust can read stdout.
  // Port 1420 avoids clashing with other Vite dev servers on 5173.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1420 } : undefined,
  },
})
