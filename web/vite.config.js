import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// `npm run dev`        → http://localhost:5330 (and LAN)
// `npm run dev:https`  → https://<your-ip>:5330 - needed for phone cameras,
//                        since browsers only allow getUserMedia on HTTPS/localhost.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    port: 5330,
    host: true, // reachable from phones/tablets on the same network
    proxy: {
      '/api': 'http://localhost:4311',
      '/uploads': 'http://localhost:4311',
    },
  },
}))
