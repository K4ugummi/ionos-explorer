import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The explorer must never talk to the IONOS API (or anything else): snapshots
// are loaded from local files only. The production CSP enforces that in the
// browser. Dev mode is exempt because Vite's HMR needs inline scripts.
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
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  }
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
})
