/** Runtime settings editor for dispatch thresholds and GTFS data sources. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getConfig, putConfig, reloadStatic, testDispatchToken } from '../api';
import { formatFocusRoutes, parseFocusRoutes } from '../focus';
import { appConfigSchema, type AppConfig } from '../../../shared/types';

export default function ConfigPage() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [terminalsJson, setTerminalsJson] = useState('');
  const [focusText, setFocusText] = useState('');
  const [token, setToken] = useState('');
  const [tokenMessage, setTokenMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    // The textarea mirrors terminals as JSON because terminals are edited as a list.
    getConfig()
      .then((cfg) => {
        setConfig(cfg);
        setTerminalsJson(JSON.stringify(cfg.terminals, null, 2));
        // Route focus is edited as a comma-separated list like every other knob.
        setFocusText(formatFocusRoutes(cfg.focusRouteIds));
      })
      .catch((err: unknown) =>
        setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) }),
      );
    // The dispatch token lives only in this browser, never in server config.
    setToken(window.localStorage.getItem('dispatchToken') ?? '');
  }, []);

  if (!config) return <div className="loading">Loading settings…</div>;

  const setNumber = (key: keyof AppConfig, value: string) => {
    // Inputs are strings, but the shared config contract requires numeric thresholds.
    setConfig({ ...config, [key]: Number(value) });
  };

  const setUrl = (value: string) => {
    setConfig({ ...config, realtime: { ...config.realtime, tripUpdatesUrl: value } });
  };

  const setVpUrl = (value: string) => {
    setConfig({ ...config, realtime: { ...config.realtime, vehiclePositionsUrl: value || undefined } });
  };

  const save = async () => {
    try {
      let terminals: AppConfig['terminals'];
      try {
        // Parse separately so malformed editor text gets a focused user-facing error.
        terminals = JSON.parse(terminalsJson) as AppConfig['terminals'];
      } catch {
        throw new Error('Terminals JSON is not valid');
      }
      const candidate = appConfigSchema.parse({
        ...config,
        terminals,
        // Comma-separated text in, trimmed/deduped array out; empty means all routes.
        focusRouteIds: parseFocusRoutes(focusText),
      });
      // Client validation gives immediate feedback; the server validates again at its boundary.
      const saved = await putConfig(candidate);
      setConfig(saved);
      setMessage({ kind: 'ok', text: 'Saved. Rule changes apply on the next refresh.' });
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const reload = async () => {
    try {
      // Static reload is independent of saving runtime thresholds.
      await reloadStatic();
      setMessage({ kind: 'ok', text: 'Static GTFS reload triggered.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const saveToken = () => {
    // The token is a browser-local credential for mutating routes; it is never sent to reads.
    const trimmed = token.trim();
    if (trimmed) window.localStorage.setItem('dispatchToken', trimmed);
    else window.localStorage.removeItem('dispatchToken');
    setToken(trimmed);
    setTokenMessage(trimmed ? 'Token saved in this browser.' : 'Token cleared.');
  };

  const clearToken = () => {
    window.localStorage.removeItem('dispatchToken');
    setToken('');
    setTokenMessage('Token cleared.');
  };

  const testToken = async () => {
    setTokenMessage('Testing…');
    const result = await testDispatchToken();
    setTokenMessage(
      result === 'ok'
        ? 'Server accepted the request (token valid, or none required).'
        : result === 'unauthorized'
          ? 'Server rejected the token (401).'
          : 'Unexpected response while testing the token.',
    );
  };

  const numeric = (value: number) => String(value);
  const rows: Array<[string, keyof AppConfig]> = [
    ['Refresh interval (s)', 'refreshIntervalSeconds'],
    ['Static refresh (h)', 'staticRefreshHours'],
    ['Min rest (min)', 'minRestMinutes'],
    ['Max hold (min)', 'maxHoldMinutes'],
    ['Lead time (min)', 'leadTimeMinutes'],
    ['Lookahead (min)', 'lookaheadMinutes'],
    ['Arrival radius (m)', 'arrivalRadiusMeters'],
    ['Terminal movement (m)', 'terminalMovementMeters'],
    ['Stationary displacement (m)', 'stationaryDisplacementMeters'],
    ['Confirm pings', 'confirmPings'],
    ['Depart pings', 'departPings'],
    ['Scheduled-arm grace (s)', 'scheduleArmGraceSeconds'],
    ['Max VP age for facts (s)', 'vehiclePositionMaxAgeSeconds'],
    ['Departure trigger (m)', 'departureTriggerMeters'],
  ];

  return (
    <div className="config-page">
      <header className="page-header">
        <Link to="/">← Terminals</Link>
      </header>
      <h1>Settings</h1>

      <section className="route-group">
        <h2>Rule parameters</h2>
        {/* Labels and matching ids preserve a usable form for keyboard and assistive-tech users. */}
        {rows.map(([label, key]) => (
          <div className="form-row" key={key}>
            <label htmlFor={key}>{label}</label>
            <input
              id={key}
              type="number"
              step="any"
              value={numeric(config[key] as number)}
              onChange={(e) => setNumber(key, e.target.value)}
            />
          </div>
        ))}
      </section>

      <section className="route-group">
        <h2>Route focus</h2>
        {/* Comma-separated route ids, saved like every other knob; empty means all routes. A focus
            change recomputes the auto-discovered terminal list server-side with no restart. */}
        <div className="form-row">
          <label htmlFor="focusRouteIds">Focus routes</label>
          <input
            id="focusRouteIds"
            type="text"
            placeholder="all routes"
            value={focusText}
            onChange={(e) => setFocusText(e.target.value)}
          />
        </div>
      </section>

      <section className="route-group">
        <h2>Data sources</h2>
        <div className="form-row">
          <label htmlFor="tu">Trip updates URL</label>
          <input
            id="tu"
            type="text"
            value={config.realtime.tripUpdatesUrl}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="vp">Vehicle positions URL</label>
          <input
            id="vp"
            type="text"
            placeholder="optional"
            value={config.realtime.vehiclePositionsUrl ?? ''}
            onChange={(e) => setVpUrl(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="apiKey">API key</label>
          <input
            id="apiKey"
            type="password"
            placeholder="unchanged"
            value={config.realtime.apiKey ?? ''}
            onChange={(e) =>
              setConfig({
                ...config,
                realtime: { ...config.realtime, apiKey: e.target.value || undefined },
              })
            }
          />
        </div>
        <div className="form-row">
          <label htmlFor="static">Static GTFS URL</label>
          <input
            id="static"
            type="text"
            value={config.staticGtfsUrl}
            onChange={(e) => setConfig({ ...config, staticGtfsUrl: e.target.value })}
          />
        </div>
      </section>

      <section className="route-group">
        <h2>Terminals (JSON)</h2>
        <textarea value={terminalsJson} onChange={(e) => setTerminalsJson(e.target.value)} />
      </section>

      <section className="route-group">
        <h2>Operator token</h2>
        {/* Optional access control: when the server sets DISPATCH_TOKEN, mutating actions need it. */}
        <div className="form-row">
          <label htmlFor="dispatchToken">Dispatch token</label>
          <input
            id="dispatchToken"
            type="password"
            placeholder="stored in this browser only"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <button type="button" onClick={saveToken}>
          Save token
        </button>
        <button type="button" onClick={() => void testToken()}>
          Test token
        </button>
        <button type="button" onClick={clearToken}>
          Clear token
        </button>
        {tokenMessage && <div className="ok-msg">{tokenMessage}</div>}
      </section>

      {message && <div className={message.kind === 'ok' ? 'ok-msg' : 'error'}>{message.text}</div>}

      <button onClick={() => void save()}>Save settings</button>
      <button onClick={() => void reload()}>Reload static GTFS</button>
    </div>
  );
}
