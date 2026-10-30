import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages 部署在 https://<user>.github.io/LLM_Charts/ ，构建时需要子路径 base。
// 本地 `npm run dev` 用根路径；可用 BASE_PATH 环境变量覆盖（自定义域名或根路径部署时设为 /）。
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: process.env.BASE_PATH ?? (command === 'serve' ? '/' : '/LLM_Charts/'),
  server: { host: '127.0.0.1', port: 5173 },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
}))
