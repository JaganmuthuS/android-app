import { isMacApp } from '../bridge';
import type { Autonomy } from '../demo';
import { WORKSPACE } from '../mock';
import { useStore } from '../store';

const OPTIONS: { value: Autonomy; label: string }[] = [
  { value: 0, label: 'Ask every change' },
  { value: 1, label: 'Ask if risky' },
  { value: 2, label: 'Autonomous' },
];

export function TitleBar() {
  const autonomy = useStore((s) => s.autonomy);
  const running = useStore((s) => s.running);
  const setAutonomy = useStore((s) => s.setAutonomy);

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
        <strong>{WORKSPACE}</strong>
        <span className="tag tag-neutral" style={{ whiteSpace: 'nowrap' }}>{running ? 4 : 3} lanes active</span>
      </div>
      <div className="autonomy">
        <span className="label muted" id="autonomy-label">Autonomy</span>
        <div className="seg" role="radiogroup" aria-labelledby="autonomy-label">
          {OPTIONS.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={autonomy === o.value} className="seg-opt" onClick={() => setAutonomy(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
