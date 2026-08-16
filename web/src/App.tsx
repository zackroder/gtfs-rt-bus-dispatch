/** Root application shell: shared navigation surrounds the route-specific pages. */
import { Link, Route, Routes } from 'react-router-dom';
import Terminals from './pages/Terminals';
import TerminalView from './pages/TerminalView';
import ConfigPage from './pages/ConfigPage';

export default function App() {
  // Keep routing in the browser so terminal links work without a full page reload.
  return (
    <div className="app">
      <header className="app-header">
        <Link className="brand" to="/">
          Bus Dispatch
        </Link>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Terminals />} />
          <Route path="/terminal/:id" element={<TerminalView />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="*" element={<p className="empty">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
