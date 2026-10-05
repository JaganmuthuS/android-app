import * as demo from '../demo';
import { MEMORY, SCOPES } from '../mock';
import { useStore } from '../store';

export function Sidebar() {
  const state = useStore();
  const lanes = demo.lanes(state);

  return (
    <aside className="col">
      <div className="lanes-head">
        <h6 style={{ margin: 0 }}>Task lanes</h6>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 13 }} title="Available in a later phase" disabled>+ New lane</button>
      </div>
      <nav className="lane-list" aria-label="Task lanes">
        {lanes.map((l, i) => (
          <button key={l.title} type="button" className="plain-btn lane-row" aria-current={state.lane === i} onClick={() => state.selectLane(i)}>
            <span className="bar" />
            <span className="lane-text">
              <span className="lane-title">{l.title}</span>
              <span className="lane-status">{l.status}</span>
              <span className={`progress${l.wait ? ' wait' : ''}`} role="progressbar" aria-valuenow={l.pct} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${l.pct}%` }} />
              </span>
            </span>
          </button>
        ))}
      </nav>
      <section className="side-block anchor">
        <h6 style={{ margin: '0 0 12px' }}>Folder access</h6>
        <div className="scope-list">
          {SCOPES.map((s) => (
            <div key={s.path} className="scope-row">
              <span>{s.path}</span>
              <span className={`tag tag-${s.tone}`}>{s.mode}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="side-block">
        <h6 style={{ margin: '0 0 8px' }}>Remembers</h6>
        <ul className="memory-list">{MEMORY.map((m) => <li key={m}>{m}</li>)}</ul>
      </section>
    </aside>
  );
}
