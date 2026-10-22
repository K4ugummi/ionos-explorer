import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ProxyOptions } from 'vite'

// The explorer talks to nothing but the server it came from: snapshots are
// opened from local files, and only when that server is ionos-explorer (the
// Go program, which marks its index.html) does the page ask it to fetch from
// the IONOS API. The browser itself never reaches IONOS or any other host;
// the production CSP enforces that, and ionos-explorer sends the same policy
// as a header (a Go test keeps the two equal). Dev mode is exempt because
// Vite's HMR needs inline scripts.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  }
}

// `IONOS_EXPLORER_URL=http://127.0.0.1:8642 npm run dev` develops the fetch
// feature against a running `ionos-explorer --listen 127.0.0.1:8642`: /api and
// /login go to it, as if the page came from it (Host and Origin rewritten,
// so its checks pass), and the page is marked like the one it serves.
// Without the variable, dev mode behaves like the static build.
const backend = process.env.IONOS_EXPLORER_URL

function localServerMarker(): Plugin {
  return {
    name: 'ionos-explorer-dev-backend',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace('<head>', '<head>\n    <meta name="ionos-explorer" content="local-server" />'),
  }
}

const proxy = (target: string): ProxyOptions => ({
  target,
  changeOrigin: true,
  configure: (p) =>
    p.on('proxyReq', (req) => {
      if (req.getHeader('origin')) req.setHeader('origin', target)
    }),
})

export default defineConfig({
  // Relative asset URLs: the build works below any path (ionos-explorer in
  // hosted mode under https://tools.example.com/ionos-explorer/, a static host).
  base: './',
  plugins: [react(), contentSecurityPolicy(), ...(backend ? [localServerMarker()] : [])],
  server: {
    // The demo snapshot is imported from ../fixtures.
    fs: { allow: ['..'] },
    proxy: backend ? { '/api': proxy(backend), '/login': proxy(backend) } : undefined,
  },
  // The diagram (React Flow, ELK client) is a lazy chunk, see App.tsx; the ELK
  // worker is a file of its own, fetched on the first layout.
})
