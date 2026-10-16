import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { takeSessionKey } from './backend/backend'

// Served by ionos-explorer: the login put the session key in the address; keep it out of the hash state and history.
takeSessionKey(window.location, window.history)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
