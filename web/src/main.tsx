import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/opsz.css';
import './styles/seed.css';
import './styles/baseline/colors.css';
import './styles/baseline/typography.css';
import './styles/baseline/spacing.css';
import './styles/baseline/motion.css';
import './styles/baseline/reset.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App.tsx';
import { applyTheme } from './theme.ts';
import { store } from './store.ts';
import { noteFirstVisit } from './prefs.ts';

// First, while this browser's prefs are untouched: applyTheme saves one on every visit.
noteFirstVisit();
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
store.start();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
