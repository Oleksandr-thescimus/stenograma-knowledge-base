const { versions } = window.kb;

// A placeholder until M3 brings the chat, the sources and their status
const App = () => (
  <main className="p-8">
    <h1 className="mb-2 text-2xl">Stenograma KB</h1>
    <p className="text-muted-foreground">
      Nothing here yet: the chat and the sources come in M3 (docs/PLAN.md).
    </p>
    <p className="mt-4 text-xs text-muted-foreground">
      Electron {versions.electron} · Chromium {versions.chrome} · Node {versions.node}
    </p>
  </main>
);

export default App;
