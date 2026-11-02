// Started as a copy of the extension's helpers/theme.ts (Meet's palette), and the app's own since
import { createTheme, type PaletteMode } from '@mui/material';

declare module '@mui/material/styles' {
  interface Palette {
    // Colors MUI has no token for, used in sx as e.g. 'stenograma.bubble'
    stenograma: {
      // Message and answer bubbles that aren't the user's own
      bubble: string;
      // Code in AI answers, shown inside a bubble
      code: string;
      // Page background
      canvas: string;
    };
  }

  interface PaletteOptions {
    stenograma?: Partial<Palette['stenograma']>;
  }
}

// The dark palette follows Google Meet's in-call UI
const PALETTES = {
  dark: {
    mode: 'dark',
    primary: { main: '#8ab4f8', contrastText: '#202124' },
    error: { main: '#f28b82' },
    success: { main: '#81c995' },
    warning: { main: '#fdd663' },
    background: { default: '#202124', paper: '#292a2d' },
    text: { primary: '#e8eaed', secondary: '#9aa0a6' },
    divider: '#3c4043',
    stenograma: { bubble: '#3c4043', code: '#202124', canvas: '#202124' },
  },
  light: {
    mode: 'light',
    stenograma: { bubble: '#f5f5f5', code: '#e8eaed', canvas: '#f5f5f5' },
  },
} as const;

const createAppTheme = (mode: PaletteMode) => createTheme({
  palette: PALETTES[mode],
  // Google Sans where it's installed, else the next fonts
  typography: { fontFamily: '"Google Sans", Roboto, Arial, sans-serif' },
  components: {
    // MUI lightens dark Paper by elevation, which Meet's flat surfaces don't do
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
  },
});

export { createAppTheme };
