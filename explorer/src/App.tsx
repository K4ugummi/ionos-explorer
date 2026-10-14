// Placeholder shell. Next step: snapshot loading (src/snapshot), the graph
// model (src/model), search (src/search) and the canvas (src/canvas).
function App() {
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>IONOS Explorer</h1>
      <p style={{ color: 'var(--muted)' }}>
        Load a snapshot (.ionx) created by <code>ionos-export</code> or <code>ionos-fixture</code>.
      </p>
    </main>
  )
}

export default App
