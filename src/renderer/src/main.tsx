import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';
import { installTauriBridge } from './tauri-bridge';
import './styles.css';

async function start() {
  await installTauriBridge();
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider><App /></I18nProvider>
    </React.StrictMode>,
  );
}

void start().catch(error => {
  // A broken desktop connection must never silently open the in-memory preview.
  const root = document.getElementById('root');
  if (root) root.textContent = error instanceof Error ? error.message : 'Unable to connect to the desktop workspace.';
  console.error('Desktop startup failed.', error);
});
