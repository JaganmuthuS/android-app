import { Fragment } from 'react';
import { currentLane, isBusy, laneCheckpoints, useStore } from '../store';

const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);

export function CheckpointBar() {
  const cps = useStore(laneCheckpoints);
  const sel = useStore((s) => s.cpSel);
  const lane = useStore(currentLane);
  const { pickCheckpoint, restore } = useStore.getState();
  const selected = cps.find((c) => c.id === sel);
  // The latest checkpoint is "now" unless something changed after it, so restoring any checkpoint is allowed.
  return (
    <footer className="cpbar">
      <div className="cpbar-label"><h6>Checkpoints</h6></div>
      <div className="timeline">
        {cps.length === 0 && <span className="muted" style={{ fontSize: 12 }}>A checkpoint is saved before every step. Click one to roll back.</span>}
        {cps.map((k) => (
          <Fragment key={k.id}>
            <button type="button" className="plain-btn cp" aria-pressed={sel === k.id} onClick={() => pickCheckpoint(k.id)} title={new Date(k.ts).toLocaleString()}>
              <span className="dot" /><b>{hhmm(k.ts)}</b><span>{k.label}</span>
            </button>
            <span className="link" aria-hidden="true" />
          </Fragment>
        ))}
      </div>
      <div className="cpbar-actions">
        {selected && (
          <button type="button" className="btn btn-secondary" disabled={isBusy(lane)} title={isBusy(lane) ? 'Stop the lane first' : undefined} onClick={() => void restore()}>
            Restore to {hhmm(selected.ts)}
          </button>
        )}
      </div>
    </footer>
  );
}
