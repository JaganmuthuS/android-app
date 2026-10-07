import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DiagnosticLine } from '../../shared/types';
import { RECOMMENDED_MODEL, type Autonomy } from '../../shared/types';
import { useStore } from '../store';
import { OLLAMA_DOWNLOAD, PullBar } from './SetupCard';

const AUTONOMY: { value: Autonomy; label: string }[] = [
  { value: 'ask_every_change', label: 'Ask every change' },
  { value: 'ask_if_risky', label: 'Ask if risky' },
  { value: 'autonomous', label: 'Autonomous' },
];

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const engine = useStore((s) => s.engine);
  const memories = useStore((s) => s.memories);
  const pull = useStore((s) => s.pull);
  const st = useStore.getState();
  const [model, setModel] = useState('');
  const [url, setUrl] = useState('');
  const [memo, setMemo] = useState('');
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [check, setCheck] = useState<{ running: boolean; lines: DiagnosticLine[]; version: string } | null>(null);
  const runCheck = async () => {
    setCheck({ running: true, lines: [], version: '' });
    try {
      const r = await window.jarvis!.diagnose();
      setCheck({ running: false, ...r });
    } catch (e) {
      setCheck({ running: false, version: '', lines: [{ ok: false, label: 'Check failed', detail: String((e as Error).message) }] });
    }
  };
  const report = check && !check.running
    ? [`JARVIS ${check.version}`, ...check.lines.map((l) => `${l.ok ? 'OK ' : 'NO '} ${l.label}${l.detail ? ` — ${l.detail}` : ''}`)].join('\n')
    : '';

  useEffect(() => {
    if (open && settings) { setModel(settings.model); setUrl(settings.ollamaUrl); setConfirmWipe(false); }
  }, [open, settings]);
  const autoCheck = useStore((s) => s.checkOnOpen);
  useEffect(() => {
    if (open && autoCheck) { useStore.setState({ checkOnOpen: false }); void runCheck(); }
  }, [open, autoCheck]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') st.openSettings(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, st]);

  if (!open || !settings) return null;
  const installed = engine?.models ?? [];
  const pulling = !!pull && !pull.done && !pull.error;
  const modelInstalled = installed.some((m) => m.name === model || m.name === `${model}:latest`);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) st.openSettings(false); }}>
      <div className="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-title settings-title" id="settings-title">Settings <span className="version">JARVIS {window.jarvis?.version}</span></div>

        <section className="settings-section" aria-labelledby="check-title">
          <h6 id="check-title">Check file access</h6>
          <p className="field-hint" style={{ marginTop: 0 }}>Tests each folder directly (no AI), then checks that the model can use file tools. Takes up to a minute.</p>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={check?.running} onClick={() => void runCheck()}>{check?.running ? 'Checking…' : 'Run the check'}</button>
            {report && <button type="button" className="btn btn-secondary" onClick={() => { void navigator.clipboard.writeText(report).then(() => st.notice('Report copied. Paste it to whoever is helping you.'), () => st.notice('Copy failed. Select the lines and copy them.')); }}>Copy report</button>}
            {check?.lines.some((l) => /System Settings/.test(l.detail ?? '')) && (
              <button type="button" className="btn btn-secondary" onClick={() => void window.jarvis?.openPrivacySettings()}>Open Privacy settings</button>
            )}
          </div>
          {check && !check.running && (
            <ul className="check-list">
              {check.lines.map((l, i) => (
                <li key={i} className={l.ok ? 'ok' : 'bad'}>
                  <span className="mark" aria-label={l.ok ? 'OK' : 'Problem'}>{l.ok ? '✓' : '✕'}</span>
                  <span><b>{l.label}</b>{l.detail && <span className="detail">{l.detail}</span>}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="settings-section">
          <h6>AI engine</h6>
          <p className="settings-status">
            {engine?.reachable
              ? <>Ollama {engine.version} is running · {installed.length} model{installed.length === 1 ? '' : 's'} downloaded</>
              : <>Ollama is not running. <button type="button" className="link-btn" onClick={() => void window.jarvis?.openExternal(OLLAMA_DOWNLOAD)}>Download Ollama</button>, open it, then check again.</>}
          </p>
          <div className="field">
            <label htmlFor="set-model">Model</label>
            <div className="row">
              <input id="set-model" className="input" list="installed-models" value={model} onChange={(e) => setModel(e.target.value.trim())} placeholder={RECOMMENDED_MODEL} />
              <datalist id="installed-models">{installed.map((m) => <option key={m.name} value={m.name}>{m.params}</option>)}</datalist>
              <button type="button" className="btn btn-secondary" disabled={!model || model === settings.model} onClick={() => void st.saveSettings({ model })}>Use model</button>
            </div>
            <p className="field-hint">
              {modelInstalled ? 'Downloaded.' : 'Not downloaded yet.'} {RECOMMENDED_MODEL} is recommended for Macs with 16 GB of memory; on 8 GB, try qwen3:4b.
            </p>
            {engine?.reachable && !modelInstalled && model && (
              <button type="button" className="btn btn-primary" disabled={pulling} onClick={() => void st.pullModel(model)}>{pulling ? 'Downloading…' : `Download ${model}`}</button>
            )}
            {engine?.reachable && <PullBar />}
          </div>
          <div className="field">
            <label htmlFor="set-url">Ollama address</label>
            <div className="row">
              <input id="set-url" className="input" value={url} onChange={(e) => setUrl(e.target.value.trim())} />
              <button type="button" className="btn btn-secondary" disabled={url === settings.ollamaUrl} onClick={() => void st.saveSettings({ ollamaUrl: url })}>Save</button>
              <button type="button" className="btn btn-secondary" onClick={() => void st.refreshEngine()}>Check again</button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h6>Behaviour</h6>
          <div className="field">
            <label id="set-autonomy">Default autonomy for new lanes</label>
            <div className="seg autonomy-seg" role="radiogroup" aria-labelledby="set-autonomy">
              {AUTONOMY.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={settings.autonomy === o.value} className="seg-opt" onClick={() => void st.saveSettings({ autonomy: o.value })}>{o.label}</button>
              ))}
            </div>
            <p className="field-hint">Every level asks before steps that send, export, delete or overwrite. Change review arrives with file editing.</p>
          </div>
          <div className="field">
            <label htmlFor="set-parallel">Lanes that can work at the same time</label>
            <select id="set-parallel" className="input" value={settings.maxParallel} onChange={(e) => void st.saveSettings({ maxParallel: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <p className="field-hint">A local model answers one request at a time, so extra lanes wait their turn.</p>
          </div>
        </section>

        <section className="settings-section">
          <h6>Memory</h6>
          <p className="field-hint">Jarvis follows these in every lane.</p>
          <ul className="memory-edit">
            {memories.map((m) => (
              <li key={m.id}>
                <label className="toggle-row">
                  <input type="checkbox" checked={m.enabled} onChange={(e) => void st.updateMemory(m.id, { enabled: e.target.checked })} />
                  <span className={m.enabled ? '' : 'muted'}>{m.text}</span>
                </label>
                <button type="button" className="btn btn-ghost icon-ghost" aria-label={`Delete memory: ${m.text}`} onClick={() => void st.deleteMemory(m.id)}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void st.addMemory(memo); setMemo(''); }}>
            <input className="input" aria-label="New memory" placeholder="e.g. Exact figures, no hedging words" value={memo} onChange={(e) => setMemo(e.target.value)} />
            <button type="submit" className="btn btn-secondary" disabled={!memo.trim()}>Add</button>
          </form>
        </section>

        <section className="settings-section">
          <h6>Data</h6>
          <p className="field-hint">Lanes, chats, memories, saved file copies and settings are stored only on this Mac.</p>
          <button type="button" className="btn btn-secondary" onClick={() => void st.exportAudit()}>Export audit log (CSV)</button>
          {confirmWipe ? (
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => { void st.deleteAllData(); setConfirmWipe(false); }}>Delete everything</button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmWipe(false)}>Keep my data</button>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmWipe(true)}>Delete all local data</button>
          )}
        </section>

        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => st.openSettings(false)}>Done</button>
        </div>
      </div>
    </div>
  );
}
