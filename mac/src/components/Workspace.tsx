import * as demo from '../demo';
import { useStore } from '../store';

const TABS: { id: demo.Tab; label: string }[] = [
  { id: 'doc', label: 'Document' },
  { id: 'research', label: 'Research' },
  { id: 'files', label: 'Files' },
];

export function Workspace() {
  const state = useStore();
  const files = demo.files(state);
  const counts = demo.tabCounts(state, files.length);

  return (
    <section className="col" aria-label="Workspace">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={state.tab === t.id} className="plain-btn tab" onClick={() => state.setTab(t.id)}>
            {t.label}{counts[t.id] && <small>{counts[t.id]}</small>}
          </button>
        ))}
      </div>
      {state.tab === 'doc' && <DocumentTab />}
      {state.tab === 'research' && <ResearchTab />}
      {state.tab === 'files' && <FilesTab rows={files} />}
    </section>
  );
}

function DocumentTab() {
  const state = useStore();
  const segs = demo.summarySegments(state);
  const rows = demo.tableRows(state);
  const sec = demo.section42(state);
  const changes = demo.availableChanges(state);
  const pending = demo.pendingCount(state);

  return (
    <div className="doc-split" role="tabpanel" aria-labelledby="tab-doc">
      <div className="doc-pane">
        <div className="doc-meta">
          <strong>Board/Q3-Board.docx</strong>
          <span className="tag tag-neutral">Word</span>
          <span className="tag tag-neutral">Template · Board v4</span>
          <span className="tag tag-accent">Styles preserved</span>
          {demo.isDone(state) && <span className="tag tag-outline">PDF exported</span>}
        </div>
        <article className="page">
          <div className="label muted">Northwind · Confidential</div>
          <h3>Q3 2026 Board Report</h3>
          <h5>2. Financial summary</h5>
          <p>{segs.map((g, i) => <span key={i} className={g.look === 'plain' ? undefined : g.look}>{g.t}</span>)}</p>
          <table className="table">
            <thead><tr><th>€M</th><th>Q2</th><th>Q3</th><th>Δ vs Q2</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.k}>
                  <td>{r.k}</td><td>{r.q2}</td>
                  <td className={[r.changed && 'changed', r.strong && 'strong'].filter(Boolean).join(' ')}>{r.q3}</td>
                  <td className={r.changed ? 'changed' : undefined}>{r.d}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h5>4.2 Regulatory outlook</h5>
          {sec === 'placeholder' && <p className="placeholder">[To be written]</p>}
          {sec === 'drafting' && (
            <div className="drafting">
              <div>Jarvis is drafting from lane 2 · 14 sources</div>
              <span style={{ width: '100%' }} /><span style={{ width: '92%' }} /><span style={{ width: '64%' }} />
            </div>
          )}
          {(sec === 'pending' || sec === 'text') && (
            <p className={sec === 'pending' ? 'ins' : undefined}>
              General-purpose AI obligations under the EU AI Act have applied since August 2025<sup>[1]</sup>. Most requirements for high-risk systems apply from August 2026<sup>[2]</sup>. Northwind’s document assistant is classed as limited risk, which carries transparency duties only<sup>[4]</sup>. Legal estimates compliance cost below €40k for FY27.
            </p>
          )}
        </article>
      </div>
      <aside className="rail" aria-label="Changes">
        <div className="rail-head">
          <h6 style={{ margin: 0 }}>Changes · {pending} open</h6>
          {pending > 1 && <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={state.acceptAll}>Accept all</button>}
        </div>
        {changes.length === 0 && <p className="rail-empty">Nothing edited yet. Every change Jarvis makes lands here first, with the reason and the source.</p>}
        {changes.map((c) => {
          const d = state.dec[c.id];
          return (
            <div key={c.id} className="change">
              <div className="change-title">{c.title}</div>
              <div className="change-why">{c.why}</div>
              {!d ? (
                <div className="change-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => state.decide(c.id, 'accepted')}>Accept</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => state.decide(c.id, 'rejected')}>Reject</button>
                </div>
              ) : (
                <div className="change-done">
                  <span className={`tag ${d === 'rejected' ? 'tag-neutral' : 'tag-accent'}`}>{d === 'accepted' ? 'Accepted' : d === 'auto' ? 'Auto-applied' : 'Rejected'}</span>
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => state.decide(c.id, undefined)}>Undo</button>
                </div>
              )}
            </div>
          );
        })}
      </aside>
    </div>
  );
}

function ResearchTab() {
  const state = useStore();
  return (
    <div className="pane" role="tabpanel" aria-labelledby="tab-research">
      <div className="pane-head">
        <div>
          <h4>EU AI Act · obligations for SaaS vendors</h4>
          <div className="muted" style={{ fontSize: 13 }}>Lane 2 · web, EUR-Lex and your Legal folder</div>
        </div>
        <span className="tag tag-accent">{demo.readLabel(state)}</span>
      </div>
      {demo.sources(state).map((s) => (
        <div key={s.n} className="source">
          <span className="source-n">{s.n}</span>
          <div className="source-text">
            <strong>{s.title}</strong>
            <span className="where">{s.where}</span>
            <span className="note">{s.note}</span>
          </div>
          <span className={`tag tag-${s.tone}`}>{s.state}</span>
        </div>
      ))}
    </div>
  );
}

function FilesTab({ rows }: { rows: demo.FileRow[] }) {
  return (
    <div className="pane" role="tabpanel" aria-labelledby="tab-files">
      <div className="pane-head">
        <h4>Files Jarvis touched</h4>
        <span className="muted" style={{ fontSize: 13 }}>This session · all reversible</span>
      </div>
      <table className="table files">
        <thead><tr><th>File</th><th>Action</th><th>Format</th><th>Lane</th></tr></thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.path}><td>{f.path}</td><td><span className={`tag tag-${f.tone}`}>{f.action}</span></td><td>{f.fmt}</td><td className="muted">{f.lane}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
