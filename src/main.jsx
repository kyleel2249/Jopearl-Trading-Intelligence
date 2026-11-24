import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import JPTISplash from './JPTISplash.jsx';
import './styles.css';
import { trackAppOpen } from './lib/cloudflare-analytics.js';
import { JPTI_CONFIG, getConfigDiagnostics } from './lib/config.js';

class StartupErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('JPTI interface render failed:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const details = this.state.error?.stack || this.state.error?.message || String(this.state.error);
      return (
        <main style={{ minHeight: '100vh', boxSizing: 'border-box', padding: '48px 20px', background: '#080d18', color: '#e8edf6', fontFamily: 'system-ui, sans-serif' }}>
          <section style={{ maxWidth: 760, margin: '8vh auto', padding: 28, border: '1px solid #633d49', borderRadius: 14, background: '#111b2a' }}>
            <p style={{ color: '#ff9f9f', fontWeight: 700, letterSpacing: 2 }}>JPTI FRONTEND ERROR</p>
            <h1 style={{ fontSize: 24 }}>The workspace could not render.</h1>
            <p style={{ color: '#a8b8cc', lineHeight: 1.6 }}>The application caught a rendering error instead of leaving a blank screen. Copy the diagnostic below when reporting the issue.</p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 16, borderRadius: 8, background: '#080f1b', color: '#ffb7a9', fontSize: 12 }}>{details}</pre>
            <button onClick={() => window.location.reload()} style={{ padding: '11px 18px', border: 0, borderRadius: 8, background: '#53c5d5', color: '#07121e', fontWeight: 700, cursor: 'pointer' }}>Reload JPTI</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch((error) => {
    console.warn('JPTI service worker registration skipped:', error);
  }));
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('JPTI startup failed: the #root element is missing from index.html.');
}

// Configuration diagnostics are intentionally non-blocking; they never stop startup or trading modules.
if (JPTI_CONFIG.features.configDiagnostics) {
  const diagnostics = getConfigDiagnostics();
  console.info('[JPTI Config]', diagnostics);
  diagnostics.warnings.forEach((warning) => console.warn('[JPTI Config]', warning));
}
// Privacy-safe app-open event; analytics failures never interrupt startup.
void trackAppOpen();

createRoot(rootElement).render(
  <React.StrictMode>
    <StartupErrorBoundary>
      <><App /><JPTISplash /></>
    </StartupErrorBoundary>
  </React.StrictMode>
);
