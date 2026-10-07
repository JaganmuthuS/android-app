import type { ScopeMode } from '../../shared/types';
import { isWaiting, useStore } from '../store';

const MODES: { value: ScopeMode; label: string }[] = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read only' },
  { value: 'edit_ask', label: 'Edit · ask' },
  { value: 'edit_auto', label: 'Edit · auto' },
];
const TONE: Record<ScopeMode, string> = { none: 'outline', read: 'neutral', edit_ask: 'accent', edit_auto: 'accent' };

export function Sidebar() {
  const lanes = useStore((s) => s.lanes);
  const laneId = useStore((s) => s.laneId);
  const memories = useStore((s) => s.memories).filter((m) => m.enabled);
  const scopes = useStore((s) => s.scopes);
  const workspace = useStore((s) => s.settings?.workspace ?? null);
  const { selectLane, newLane, openSettings, chooseWorkspace, setScope, setAllScopes } = useStore.getState();

  return (
    <aside className="col">
      <div className="lanes-head">
        <h6 style={{ margin: 0 }}>Task lanes</h6>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => void newLane()}>+ New lane</button>
      </div>
      <nav className="lane-list" aria-label="Task lanes">
        {lanes.map((l) => (
          <button key={l.id} type="button" className="plain-btn lane-row" aria-current={laneId === l.id} onClick={() => void selectLane(l.id)}>
            <span className="bar" />
            <span className="lane-text">
              <span className="lane-title">{l.title}</span>
              <span className="lane-status">{l.statusText}</span>
              <span className={`progress${isWaiting(l) ? ' wait' : ''}`} role="progressbar" aria-valuenow={Math.round(l.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.round(l.progress * 100)}%` }} />
              </span>
            </span>
          </button>
        ))}
      </nav>
      <section className="side-block anchor">
        <div className="access-head">
          <h6 style={{ margin: 0 }}>Folder access</h6>
          {workspace && scopes.length > 0 && (
            <select className="set-all" aria-label="Set access for every folder" value="" onChange={(e) => { if (e.target.value) void setAllScopes(e.target.value as ScopeMode); }}>
              <option value="">Set all…</option>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          )}
        </div>
        {!workspace ? (
          <div className="side-empty">
            <p>Choose the folder Jarvis works in. Every folder inside starts with no access.</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void chooseWorkspace()}>Choose workspace folder</button>
          </div>
        ) : (
          <div className="scope-list">
            {scopes.map((sc) => (
              <div key={sc.path} className="scope-row">
                <span title={sc.path ? `${sc.path}/ and everything inside it` : 'Files directly in the workspace folder, and new folders Jarvis creates there'}>{sc.path ? `${sc.path}/` : 'Main folder'}</span>
                <select
                  className={`scope-select tag tag-${TONE[sc.mode]}`}
                  aria-label={`Access for ${sc.path || 'main folder'}`}
                  value={sc.mode}
                  onChange={(e) => void setScope(sc.path, e.target.value as ScopeMode)}
                >
                  {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            ))}
            {scopes.length === 0 && <p className="side-empty">This folder is empty.</p>}
            <button type="button" className="link-btn check-link" onClick={() => { useStore.setState({ checkOnOpen: true }); openSettings(true); }}>Check file access</button>
          </div>
        )}
      </section>
      <section className="side-block">
        <h6 style={{ margin: '0 0 8px' }}>Remembers</h6>
        {memories.length ? (
          <ul className="memory-list">{memories.map((m) => <li key={m.id}>{m.text}</li>)}</ul>
        ) : (
          <p className="side-empty">Nothing yet. <button type="button" className="link-btn" onClick={() => openSettings(true)}>Add a memory</button> such as “Exact figures, no hedging words”.</p>
        )}
      </section>
    </aside>
  );
}
