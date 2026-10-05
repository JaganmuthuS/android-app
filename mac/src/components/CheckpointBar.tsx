import { Fragment } from 'react';
import * as demo from '../demo';
import { TIMES } from '../mock';
import { useStore } from '../store';

export function CheckpointBar() {
  const state = useStore();
  const cps = demo.checkpoints(state);

  return (
    <footer className="cpbar">
      <div className="cpbar-label"><h6>Checkpoints</h6></div>
      <div className="timeline">
        {cps.length === 0 && <span className="muted" style={{ fontSize: 12 }}>A checkpoint is saved before every step. Click one to roll back.</span>}
        {cps.map((k) => (
          <Fragment key={k.index}>
            <button type="button" className="plain-btn cp" aria-pressed={state.cpSel === k.index} onClick={() => state.pickCheckpoint(k.index)}>
              <span className="dot" /><b>{k.time}</b><span>{k.label}</span>
            </button>
            <span className="link" aria-hidden="true" />
          </Fragment>
        ))}
      </div>
      <div className="cpbar-actions">
        {demo.canRestore(state) && <button type="button" className="btn btn-secondary" onClick={state.restore}>Restore to {TIMES[state.cpSel!]}</button>}
      </div>
    </footer>
  );
}
