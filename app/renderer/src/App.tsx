import { Box, Typography } from '@mui/material';

const { versions } = window.kb;

// A placeholder until M3 brings the chat, the sources and their status
const App = () => (
  <Box sx={{ p: 4 }}>
    <Typography variant="h5" component="h1" gutterBottom>
      Stenograma KB
    </Typography>
    <Typography color="text.secondary">
      Nothing here yet: the chat and the sources come in M3 (docs/PLAN.md).
    </Typography>
    <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
      Electron {versions.electron} · Chromium {versions.chrome} · Node {versions.node}
    </Typography>
  </Box>
);

export default App;
