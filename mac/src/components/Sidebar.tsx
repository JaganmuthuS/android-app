import { isWaiting, useStore } from '../store';

export function Sidebar() {
  const lanes = useStore((s) => s.lanes);
  const laneId = useStore((s) => s.laneId);
  const memories = useStore((s) => s.memories).filter((m) => m.enabled);
  const { selectLane, newLane, openSettings } = useStore.getState();

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
        <h6 style={{ margin: '0 0 12px' }}>Folder access</h6>
        <p className="side-empty">No folders yet. Jarvis can't open files until folder access arrives in the next update.</p>
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
