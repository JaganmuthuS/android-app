import { RECOMMENDED_MODEL } from '../../shared/types';
import { useStore } from '../store';

export const OLLAMA_DOWNLOAD = 'https://ollama.com/download/mac';

export function PullBar() {
  const pull = useStore((s) => s.pull);
  if (!pull) return null;
  if (pull.error) return <p className="setup-error" role="alert">Download stopped: {pull.error}</p>;
  if (pull.done) return <p className="setup-ok">Download complete.</p>;
  const pct = pull.total ? Math.round(((pull.completed ?? 0) / pull.total) * 100) : null;
  return (
    <div className="pull">
      <div className="pull-text">
        <span>{pull.status || 'Downloading…'}</span>
        {pct !== null && <span>{pct}% · {gb(pull.completed ?? 0)} of {gb(pull.total!)}</span>}
      </div>
      <span className="progress"><span style={{ width: `${pct ?? 0}%` }} /></span>
    </div>
  );
}

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

/** Shown in the chat until the local AI engine is installed and has a model. */
export function SetupCard() {
  const engine = useStore((s) => s.engine);
  const model = useStore((s) => s.settings?.model ?? RECOMMENDED_MODEL);
  const pull = useStore((s) => s.pull);
  const { refreshEngine, pullModel, openSettings } = useStore.getState();
  const reachable = !!engine?.reachable;
  const pulling = !!pull && !pull.done && !pull.error;

  return (
    <div className="setup" role="region" aria-label="Set up the AI engine">
      <div className="setup-head label">Set up Jarvis · free, runs on this Mac</div>
      <ol className="setup-steps">
        <li className={reachable ? 'ok' : ''}>
          <div>
            <b>Install Ollama</b>
            <span>The free app that runs Jarvis's AI model on your Mac. Nothing you type leaves this computer.</span>
            {!reachable && (
              <div className="setup-actions">
                <button type="button" className="btn btn-primary" onClick={() => void window.jarvis?.openExternal(OLLAMA_DOWNLOAD)}>Download Ollama</button>
                <button type="button" className="btn btn-secondary" onClick={() => void refreshEngine()}>I've opened it, check again</button>
              </div>
            )}
            {reachable && <span className="setup-ok">Ollama {engine?.version} is running.</span>}
          </div>
        </li>
        <li className={engine?.modelInstalled ? 'ok' : ''}>
          <div>
            <b>Download the model</b>
            <span>
              {model === RECOMMENDED_MODEL
                ? <><code>{model}</code> is about 5 GB and works well on Apple silicon Macs with 16 GB of memory. On an 8 GB Mac, choose qwen3:4b in Settings.</>
                : <>Jarvis is set to use <code>{model}</code>. Ollama downloads it once and keeps it on this Mac.</>}
            </span>
            {reachable && !engine?.modelInstalled && (
              <div className="setup-actions">
                <button type="button" className="btn btn-primary" disabled={pulling} onClick={() => void pullModel(model)}>{pulling ? 'Downloading…' : `Download ${model}`}</button>
                <button type="button" className="btn btn-secondary" onClick={() => openSettings(true)}>Choose another model</button>
              </div>
            )}
            {reachable && <PullBar />}
          </div>
        </li>
      </ol>
    </div>
  );
}
