import { Link, Route, Routes } from 'react-router-dom';
import Terminals from './pages/Terminals';
import TerminalView from './pages/TerminalView';
import ConfigPage from './pages/ConfigPage';

export default function App() {
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
        </Routes>
      </main>
    </div>
  );
}
