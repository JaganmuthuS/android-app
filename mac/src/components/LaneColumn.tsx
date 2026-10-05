import { ArrowUp, Mic } from 'lucide-react';
import { useEffect, useRef } from 'react';
import * as demo from '../demo';
import { useStore } from '../store';

export function LaneColumn() {
  const state = useStore();
  const lanes = demo.lanes(state);
  const lane = lanes[state.lane];
  const isMain = state.lane === 0;

  return (
    <section className="col" aria-label={`Lane ${state.lane + 1}`}>
      <div className="lane-head">
        <div className="label lane-kicker">Lane {state.lane + 1}</div>
        <div className="lane-name">{lane.title}</div>
      </div>
      {isMain ? <Chat /> : (
        <div className="other-lane">
          <div className="card">
            <div className="card-kicker">{lane.status}</div>
            <div className="card-body">{lane.last}</div>
            <div className="card-meta">Updated {lane.when}</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => state.selectLane(0)}>Back to {lanes[0].title}</button>
        </div>
      )}
      <Composer />
    </section>
  );
}

function Chat() {
  const state = useStore();
  const items = demo.chatItems(state);
  const ref = useRef<HTMLDivElement>(null);
  const thinking = demo.isThinking(state);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items.length, state.step, state.running]);

  return (
    <div className="chat" ref={ref}>
      {items.map((m, i) => {
        switch (m.kind) {
          case 'user': return <div key={i} className="msg-user">{m.text}</div>;
          case 'text': return (
            <div key={i} className="msg-jarvis"><span className="label">Jarvis</span><p>{m.text}</p></div>
          );
          case 'log': return <div key={i} className="log"><b>{m.verb}</b><span>{m.what}</span></div>;
          case 'plan': return <PlanCard key={i} />;
          case 'gate': return <GateCard key={i} />;
        }
      })}
      {thinking && <div className="thinking">{demo.thinkingText(state)}</div>}
    </div>
  );
}

function PlanCard() {
  const state = useStore();
  const steps = demo.planSteps(state);
  const showActions = state.planShown && !state.approved;
  const showResume = state.approved && !state.running && state.step < 4 && state.restored;

  return (
    <div className="plan">
      <div className="plan-head">
        <span className="label">Plan · {demo.planProgress(state)}</span>
        <span className="scope">Scope: Finance (read) · Board (write)</span>
      </div>
      {steps.map((s) => (
        <div key={s.text} className={`plan-step step-${s.state}`}>
          <span className={`sq ${s.state}`} />
          <span className="step-text">{s.text}</span>
          <span className="step-note">{s.note}</span>
        </div>
      ))}
      {showActions && (
        <div className="plan-actions">
          <button type="button" className="btn btn-primary" onClick={state.approvePlan}>Approve plan</button>
          <button type="button" className="btn btn-secondary" title="Available in a later phase" disabled>Edit steps</button>
        </div>
      )}
      {showResume && (
        <div className="plan-actions">
          <button type="button" className="btn btn-primary" onClick={state.resume}>Resume from step {state.step + 1}</button>
          <span className="muted" style={{ fontSize: 12 }}>Restored to checkpoint</span>
        </div>
      )}
    </div>
  );
}

function GateCard() {
  const state = useStore();
  const blocked = demo.pendingCount(state) > 0 || demo.isDone(state);
  return (
    <div className="gate" role="group" aria-label="Approval needed">
      <div className="gate-head label">Approval needed</div>
      <div className="gate-body">Export Q3-Board.docx to <b>Board/Out/Q3-Board.pdf</b>. This is the first file that leaves the working draft.</div>
      <div className="gate-actions">
        <button type="button" className="btn btn-primary" disabled={blocked} onClick={state.approveExport}>Approve export</button>
        <span>{demo.gateNote(state)}</span>
      </div>
    </div>
  );
}

function Composer() {
  const draft = useStore((s) => s.draft);
  const sent = useStore((s) => s.sent);
  const voice = useStore((s) => s.voice);
  const { setDraft, send, toggleVoice } = useStore.getState();

  return (
    <div className="composer">
      {!sent && (
        <div className="chips">
          <span className="tag tag-outline">@Q3-Board.docx</span>
          <span className="tag tag-outline">@Sept-close.xlsx</span>
          <span className="tag tag-neutral">@lane EU AI Act</span>
        </div>
      )}
      <div className="composer-row">
        <textarea
          id="composer-input"
          className="input"
          aria-label="Message Jarvis"
          value={draft}
          placeholder="Ask Jarvis, or type / for commands"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
        />
        <button type="button" className="btn btn-secondary btn-icon" title="Hold to talk" aria-label="Voice input" aria-pressed={voice} onClick={toggleVoice}>
          <Mic size={18} />
        </button>
        <button type="button" className="btn btn-primary btn-icon" title="Send (Return)" aria-label="Send" onClick={send}>
          <ArrowUp size={18} />
        </button>
      </div>
      <div className="hint">{voice ? 'Listening… release to send' : 'Return to send · ⌥ Space summons Jarvis from the menu bar in any app'}</div>
    </div>
  );
}
