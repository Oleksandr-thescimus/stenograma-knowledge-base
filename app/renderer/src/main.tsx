import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { StatusProvider } from './lib/kb';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StatusProvider>
      <App />
    </StatusProvider>
  </StrictMode>,
);
