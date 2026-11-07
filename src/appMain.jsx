// Rituals fork (2026-11-05): the app proper, loaded by src/main.jsx only after the
// one-identity-per-Rituals-account check (ensureSpaceAccount) has run.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './components/theme-provider.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import App from './App';
import { queryClient } from './lib/queryClient.ts';
import { registerPWA } from './lib/pwaUpdate';
import { applyStoredAppearancePreferences } from './lib/appearancePreferences.ts';
import { getRendererDiagnosticLog } from './lib/diagnosticLog';
import { flushBootUpdateDiagnostics } from './lib/quietUpdate';
import { installChunkRecovery } from './lib/chunkRecovery';
import {
  markDesktopShellDocument,
  signalDesktopRendererReady,
} from './hooks/useDesktopShell.js';
import './styles/global.css';

/* global __HUSH_DEV_DEBUG__, __HUSH_DEBUG_TOOLBAR__, __HUSH_ERUDA__ */

// Register the PWA Service Worker. Fire-and-forget — the function itself
// guards against unsupported environments. Registration failures are
// non-fatal: the Update Required dialog still works via its fallback path.
// HUSHHQ-79: initialize the diagnostic ring buffer + global capture
// once at boot. The buffer is in-memory only and never leaves the
// device unless the user explicitly attaches it to a bug report.
getRendererDiagnosticLog();
// Rituals fork: boot's update outcomes, kept until the log above listens, and
// recovery for a file of this build that fails to load after a release.
flushBootUpdateDiagnostics();
installChunkRecovery();

registerPWA();
markDesktopShellDocument();
applyStoredAppearancePreferences();
signalDesktopRendererReady();

// Dev-only debug tools. __HUSH_DEV_DEBUG__ is a Vite define, so production
// builds tree-shake this dynamic import and never emit the eruda chunk.
if (
  __HUSH_DEV_DEBUG__ &&
  (__HUSH_DEBUG_TOOLBAR__ || __HUSH_ERUDA__)
) {
  import('./lib/devDebugTools').then(({ installDevDebugTools }) => {
    installDevDebugTools({
      enableToolbar: __HUSH_DEBUG_TOOLBAR__,
      enableEruda: __HUSH_ERUDA__,
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <ThemeProvider>
        <TooltipProvider>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
