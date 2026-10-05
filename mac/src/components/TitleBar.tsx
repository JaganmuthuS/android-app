import { Settings as SettingsIcon } from 'lucide-react';
import { isMacApp } from '../api';
import type { Autonomy } from '../../shared/types';
import { currentLane, isBusy, useStore } from '../store';

const OPTIONS: { value: Autonomy; label: string }[] = [
  { value: 'ask_every_change', label: 'Ask every change' },
  { value: 'ask_if_risky', label: 'Ask if risky' },
  { value: 'autonomous', label: 'Autonomous' },
];

export function TitleBar() {
  const lanes = useStore((s) => s.lanes);
  const lane = useStore(currentLane);
  const fallback = useStore((s) => s.settings?.autonomy ?? 'ask_every_change');
  const { setAutonomy, openSettings } = useStore.getState();
  const autonomy = lane?.autonomy ?? fallback;
  const active = lanes.filter((l) => isBusy(l)).length;

  return (
    <header className="titlebar">
      <div className={`brand${isMacApp ? ' native-lights' : ''}`}>
        {!isMacApp && (
          <div className="lights" aria-hidden="true">
            <span style={{ background: '#ff5f57' }} /><span style={{ background: '#febc2e' }} /><span style={{ background: '#28c840' }} />
          </div>
        )}
        <div className="wordmark">JARVIS</div>
        <span className="brand-square" aria-hidden="true" />
      </div>
      <div className="workspace">
        <span className="muted">Workspace</span>
        <strong>Not set yet</strong>
        <span className="tag tag-neutral" style={{ whiteSpace: 'nowrap' }}>{active} {active === 1 ? 'lane' : 'lanes'} active</span>
      </div>
      <div className="autonomy">
        <span className="label muted" id="autonomy-label">Autonomy</span>
        <div className="seg" role="radiogroup" aria-labelledby="autonomy-label">
          {OPTIONS.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={autonomy === o.value} className="seg-opt" onClick={() => void setAutonomy(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-secondary btn-icon" aria-label="Settings" title="Settings" onClick={() => openSettings(true)}>
          <SettingsIcon size={18} />
        </button>
      </div>
    </header>
  );
}
