import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// El build va a ../public, que es lo que sirve el monitor (src/server/http.js).
// Se commitea compilado para que `npm start` funcione sin instalar nada.
// En desarrollo: `npm run dev` aquí y el monitor en :3333 (la API se proxifica).
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5174,
    proxy: { "/api": { target: "http://127.0.0.1:3333", changeOrigin: false } },
  },
})
