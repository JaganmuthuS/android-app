import { ArrowDown, ArrowUp, Mic, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Lane, Message, PlanStep } from '../../shared/types';
import { currentLane, engineReady, isBusy, useStore } from '../store';
import { SetupCard } from './SetupCard';

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_STEPS: PlanStep[] = [];

export function LaneColumn() {
  const lane = useStore(currentLane);
  const lanes = useStore((s) => s.lanes);
  const index = lane ? lanes.findIndex((l) => l.id === lane.id) : -1;
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [lane?.id]);

  return (
    <section className="col" aria-label={lane ? `Lane ${index + 1}` : 'Lane'}>
      <div className="lane-head">
        <div className="lane-head-row">
          <div className="label lane-kicker">Lane {index + 1}</div>
          {lane && lanes.length > 1 && (
            confirmDelete ? (
              <span className="lane-delete">
                <span>Delete this lane?</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void useStore.getState().deleteLane(lane.id)}>Delete</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Keep</button>
              </span>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm icon-ghost" aria-label="Delete lane" title="Delete lane" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} />
              </button>
            )
          )}
        </div>
        <div className="lane-name">{lane?.title ?? ''}</div>
      </div>
      {lane && <Chat lane={lane} />}
      {lane && <Composer lane={lane} />}
    </section>
  );
}

function Chat({ lane }: { lane: Lane }) {
  const messages = useStore((s) => s.messages[lane.id] ?? EMPTY_MESSAGES);
  const steps = useStore((s) => s.steps[lane.id] ?? EMPTY_STEPS);
  const streams = useStore((s) => s.streams);
  const ready = useStore(engineReady);
  const engineKnown = useStore((s) => s.engine !== null);
  const ref = useRef<HTMLDivElement>(null);
  const lastPlan = messages.map((m) => m.kind).lastIndexOf('plan');
  const streamingText = messages.some((m) => streams[m.id]);
  const thinking = isBusy(lane) && !streamingText;
  const running = steps.find((s) => s.state === 'running');
  const scrollKey = `${messages.length}|${Object.values(streams).join('').length}|${lane.status}`;

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [scrollKey]);

  return (
    <div className="chat" ref={ref}>
      {engineKnown && !ready && <SetupCard />}
      {messages.length === 0 && ready && (
        <div className="msg-jarvis">
          <span className="label">Jarvis</span>
          <p>What should I work on? Ask a question, or describe a task and I will plan it before doing anything.</p>
        </div>
      )}
      {messages.map((m, i) => {
        const p = m.payload;
        switch (m.kind) {
          case 'text': {
            if (m.role === 'user') return <div key={m.id} className="msg-user">{String(p.text)}</div>;
            const text = streams[m.id] ?? String(p.text ?? '');
            if (!text && !p.streaming) return null;
            if (!text) return null;
            return (
              <div key={m.id} className="msg-jarvis">
                <span className="label">{p.step ? `Jarvis · step ${String(p.step)}` : 'Jarvis'}</span>
                <p><Cited text={text} />{p.interrupted ? <span className="muted"> (stopped)</span> : null}</p>
              </div>
            );
          }
          case 'plan':
            return i === lastPlan
              ? <PlanCard key={m.id} lane={lane} steps={steps} scope={String(p.scope ?? '')} />
              : <div key={m.id} className="log"><b>Plan</b><span>Replaced by a newer plan</span></div>;
          case 'log': return <div key={m.id} className="log"><b>{String(p.verb)}</b><span>{String(p.what)}</span></div>;
          case 'gate': return <GateCard key={m.id} lane={lane} message={m} />;
          case 'error': return <ErrorCard key={m.id} message={m} />;
          default: return null;
        }
      })}
      {thinking && (
        <div className="thinking">
          {lane.statusText.startsWith('Queued') ? lane.statusText
            : lane.status === 'planning' ? 'Reading the request and checking folder access…'
            : running ? `Step ${running.index + 1}: ${running.text}` : 'Working…'}
        </div>
      )}
    </div>
  );
}

function PlanCard({ lane, steps, scope }: { lane: Lane; steps: PlanStep[]; scope: string }) {
  const [editing, setEditing] = useState<{ text: string; requiresGate: boolean }[] | null>(null);
  const { approvePlan, savePlan, resume } = useStore.getState();
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  const awaiting = lane.status === 'awaiting_plan_approval';
  const next = steps.find((s) => s.state === 'queued');
  useEffect(() => { if (!awaiting) setEditing(null); }, [awaiting]);

  const move = (i: number, d: number) => setEditing((e) => {
    if (!e) return e;
    const j = i + d;
    if (j < 0 || j >= e.length) return e;
    const c = [...e];
    [c[i], c[j]] = [c[j], c[i]];
    return c;
  });

  return (
    <div className="plan">
      <div className="plan-head">
        <span className="label">Plan · {done} of {steps.length}</span>
        {scope && <span className="scope">Scope: {scope}</span>}
      </div>
      {editing ? (
        <div className="plan-edit">
          {editing.map((s, i) => (
            <div key={i} className="plan-edit-row">
              <span className="step-num">{i + 1}</span>
              <input
                className="input"
                aria-label={`Step ${i + 1}`}
                value={s.text}
                onChange={(e) => setEditing((cur) => cur!.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
              />
              <label className="gate-toggle" title="Ask before this step runs">
                <input type="checkbox" checked={s.requiresGate} onChange={(e) => setEditing((cur) => cur!.map((x, k) => (k === i ? { ...x, requiresGate: e.target.checked } : x)))} />
                Gate
              </label>
              <button type="button" className="btn btn-ghost icon-ghost" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
              <button type="button" className="btn btn-ghost icon-ghost" aria-label={`Move step ${i + 1} down`} disabled={i === editing.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
              <button type="button" className="btn btn-ghost icon-ghost" aria-label={`Delete step ${i + 1}`} disabled={editing.length === 1} onClick={() => setEditing((cur) => cur!.filter((_, k) => k !== i))}><X size={14} /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost add-step" onClick={() => setEditing((cur) => [...cur!, { text: '', requiresGate: false }])}><Plus size={14} /> Add step</button>
        </div>
      ) : (
        steps.map((s) => {
          const gate = s.requiresGate && s.state === 'queued' && s.note !== 'approved';
          const look = s.state === 'running' ? 'running' : s.state === 'done' ? 'done' : s.state === 'skipped' ? 'skipped' : gate ? 'gate' : 'queued';
          const note = s.state === 'done' ? 'done' : s.state === 'running' ? 'working' : s.state === 'skipped' ? 'skipped' : gate ? 'needs your approval' : '';
          return (
            <div key={s.id} className={`plan-step step-${look}`}>
              <span className={`sq ${look}`} />
              <span className="step-text">{s.text}</span>
              <span className="step-note">{note}</span>
            </div>
          );
        })
      )}
      {awaiting && !editing && (
        <div className="plan-actions">
          <button type="button" className="btn btn-primary" onClick={() => void approvePlan()}>Approve plan</button>
          <button type="button" className="btn btn-secondary" onClick={() => setEditing(steps.map((s) => ({ text: s.text, requiresGate: s.requiresGate })))}>Edit steps</button>
        </div>
      )}
      {editing && (
        <div className="plan-actions">
          <button type="button" className="btn btn-primary" onClick={async () => { if (await savePlan(editing)) setEditing(null); }}>Save steps</button>
          <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      )}
      {lane.status === 'paused' && next && (
        <div className="plan-actions">
          <button type="button" className="btn btn-primary" onClick={() => void resume()}>Resume from step {next.index + 1}</button>
          <span className="muted" style={{ fontSize: 12 }}>{lane.statusText}</span>
        </div>
      )}
    </div>
  );
}

function ErrorCard({ message }: { message: Message }) {
  const p = message.payload;
  const grantPath = typeof p.grantPath === 'string' ? p.grantPath : null;
  const scopes = useStore((s) => s.scopes);
  const current = grantPath !== null ? scopes.find((x) => x.path === grantPath)?.mode : undefined;
  const want = p.grantMode === 'read' ? 'read' : 'edit_ask';
  const granted = current && (want === 'read' ? current !== 'none' : current === 'edit_ask' || current === 'edit_auto');
  const where = grantPath ? `${grantPath}/` : 'top-level files';
  return (
    <div className="error-card" role="alert">
      <b className="label">{grantPath !== null ? 'No access' : 'Problem'}</b>
      <span>{String(p.text)}</span>
      {p.privacy === true && (
        <span className="row-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.jarvis?.openPrivacySettings()}>Open Privacy settings</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { useStore.setState({ checkOnOpen: true }); useStore.getState().openSettings(true); }}>Check file access</button>
        </span>
      )}
      {grantPath !== null && current !== undefined && (
        granted
          ? <span className="muted">Access granted. Send the request again to continue.</span>
          : <button type="button" className="btn btn-secondary btn-sm" onClick={() => void useStore.getState().setScope(grantPath, want)}>
              {want === 'read' ? `Allow reading ${where}` : `Allow editing ${where} (with review)`}
            </button>
      )}
    </div>
  );
}

function GateCard({ lane, message }: { lane: Lane; message: Message }) {
  const { approveGate, skipGate } = useStore.getState();
  const open = useStore((s) => (s.changes[lane.id] ?? []).filter((c) => c.status === 'pending').length);
  const state = String(message.payload.state);
  const pending = state === 'pending' && lane.status === 'awaiting_gate';
  return (
    <div className="gate" role="group" aria-label="Approval needed">
      <div className="gate-head label">{pending ? 'Approval needed' : 'Approval'}</div>
      <div className="gate-body">
        Next step: <b>{String(message.payload.text)}</b>. This step can send, export, delete or overwrite something, so Jarvis waits for you.
      </div>
      <div className="gate-actions">
        {pending ? (
          <>
            <button type="button" className="btn btn-primary" disabled={open > 0} onClick={() => void approveGate()}>Approve step</button>
            <button type="button" className="btn btn-secondary" onClick={() => void skipGate()}>Skip it</button>
            {open > 0 && <span>Review {open} open change{open > 1 ? 's' : ''} first</span>}
          </>
        ) : (
          <span className="tag tag-accent">{state === 'approved' ? 'Approved' : state === 'skipped' ? 'Skipped' : 'Replaced by a newer request'}</span>
        )}
      </div>
    </div>
  );
}

/** Edits wait for the user; make that impossible to miss. */
function PendingBanner({ lane }: { lane: Lane }) {
  const open = useStore((s) => (s.changes[lane.id] ?? []).filter((c) => c.status === 'pending').length);
  const firstId = useStore((s) => (s.changes[lane.id] ?? []).find((c) => c.status === 'pending')?.id ?? null);
  if (!open) return null;
  const st = useStore.getState();
  return (
    <div className="pending-banner" role="status">
      <span><b>{open} change{open > 1 ? 's' : ''} waiting for you.</b> Nothing is saved to your files until you accept.</span>
      <span className="row-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => firstId && st.focusChange(firstId)}>Review</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void (open > 1 ? st.acceptAll() : st.decideChange(firstId!, 'accept'))}>{open > 1 ? 'Accept all' : 'Accept'}</button>
      </span>
    </div>
  );
}

function Composer({ lane }: { lane: Lane }) {
  const draft = useStore((s) => s.drafts[lane.id] ?? '');
  const ready = useStore(engineReady);
  const { setDraft, send, stop } = useStore.getState();
  const busy = isBusy(lane);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, [lane.id]);

  return (
    <div className="composer">
      <PendingBanner lane={lane} />
      <div className="composer-row">
        <textarea
          ref={inputRef}
          id="composer-input"
          className="input"
          aria-label="Message Jarvis"
          value={draft}
          placeholder={ready ? 'Ask Jarvis, or describe a task' : 'Finish the setup above to start'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) void send(); }
          }}
        />
        <button type="button" className="btn btn-secondary btn-icon" aria-label="Voice input" title="Voice input arrives in a later update" disabled>
          <Mic size={18} />
        </button>
        {busy ? (
          <button type="button" className="btn btn-secondary btn-icon" aria-label="Stop" title="Stop this lane" onClick={() => void stop()}>
            <Square size={16} />
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-icon" aria-label="Send" title="Send (Return)" disabled={!draft.trim()} onClick={() => void send()}>
            <ArrowUp size={18} />
          </button>
        )}
      </div>
      <div className="hint">{busy ? 'Jarvis is working. Stop pauses the lane; you can resume it.' : 'Return to send · Shift+Return for a new line'}</div>
    </div>
  );
}

/** Reply text with [n] citations as buttons that open the source in the Research tab. */
function Cited({ text }: { text: string }) {
  const focusSource = useStore((s) => s.focusSource);
  const parts = text.split(/(\[\d{1,3}\])/);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => {
        const n = part.match(/^\[(\d{1,3})\]$/)?.[1];
        return n
          ? <button key={i} type="button" className="plain-btn cite" aria-label={`Source ${n}`} onClick={() => focusSource(Number(n))}>{n}</button>
          : <span key={i}>{part}</span>;
      })}
    </>
  );
}
