import { createRoot } from 'react-dom/client';
import './styles.css';
import './pixel-theme.css';
import '../../../src/resource-plugins/bundled/styles.generated.css';
import './safety.css';
import { RendererSpike } from './spike.tsx';
import { WorkspaceMap } from './workspace-map.tsx';
import { ErrorBoundary, ErrorScreen, rootErrorOptions } from './error-screen.tsx';
import { installedRenderersReady } from './installed-plugins.ts';

function App() {
  return <main className="workspace">
    {new URLSearchParams(location.search).has('spike') ? <RendererSpike /> : <WorkspaceMap />}
  </main>;
}

void installedRenderersReady();
createRoot(document.getElementById('root')!, rootErrorOptions).render(<ErrorBoundary fallback={(error, reset) => <main className="workspace"><ErrorScreen error={error} kind="render" retry={reset} /></main>}><App /></ErrorBoundary>);
