import { diffLines, diffWordsWithSpace, type Change as DiffPart } from 'diff';
import type { Change, FileTouch, UiState } from '../../shared/types';
import { laneChanges, useStore } from '../store';

const TABS: { id: UiState['tab']; label: string }[] = [
  { id: 'doc', label: 'Document' },
  { id: 'research', label: 'Research' },
  { id: 'files', label: 'Files' },
];

export function Workspace() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const changes = useStore(laneChanges);
  const touches = useStore((s) => s.touches);
  const open = changes.filter((c) => c.status === 'pending').length;
  const counts: Record<UiState['tab'], string> = { doc: open ? `${open} to review` : '', research: '', files: touches.length ? String(touches.length) : '' };

  return (
    <section className="col" aria-label="Workspace">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} className="plain-btn tab" onClick={() => setTab(t.id)}>
            {t.label}{counts[t.id] && <small>{counts[t.id]}</small>}
          </button>
        ))}
      </div>
      {tab === 'doc' && <DocumentTab changes={changes} />}
      {tab === 'research' && (
        <div className="pane" role="tabpanel" aria-labelledby="tab-research">
          <div className="empty-state">
            <h5>No sources yet</h5>
            <p>Research lanes will list every source Jarvis reads, numbered, with whether it was cited and why. Web research arrives in a later update.</p>
          </div>
        </div>
      )}
      {tab === 'files' && <FilesTab touches={touches} />}
    </section>
  );
}

const STATUS_LABEL: Record<Change['status'], string> = { pending: 'Open', accepted: 'Accepted', rejected: 'Rejected', auto_applied: 'Auto-applied' };

function DocumentTab({ changes }: { changes: Change[] }) {
  const focused = useStore((s) => s.focusedChange);
  const { decideChange, acceptAll, focusChange } = useStore.getState();
  const pending = changes.filter((c) => c.status === 'pending');
  const current = changes.find((c) => c.id === focused) ?? pending[0] ?? changes.at(-1) ?? null;

  return (
    <div className="doc-split" role="tabpanel" aria-labelledby="tab-doc">
      <div className="doc-pane">
        {current ? <ChangeView change={current} /> : (
          <div className="empty-state">
            <h5>No changes yet</h5>
            <p>When Jarvis edits or creates a file, it appears here with every change marked inline. Nothing reaches your files until you accept it, unless your autonomy setting allows it.</p>
          </div>
        )}
      </div>
      <aside className="rail" aria-label="Changes">
        <div className="rail-head">
          <h6 style={{ margin: 0 }}>Changes · {pending.length} open</h6>
          {pending.length > 1 && <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => void acceptAll()}>Accept all</button>}
        </div>
        {changes.length === 0 && <p className="rail-empty">Nothing edited yet. Every change Jarvis makes lands here first, with the reason and the source.</p>}
        {changes.map((c) => (
          <div key={c.id} className={`change${current?.id === c.id ? ' focused' : ''}`}>
            <button type="button" className="plain-btn change-title" onClick={() => focusChange(c.id)}>{c.title}</button>
            <div className="change-file">{c.moveTo ? `${c.filePath} → ${c.moveTo}` : c.filePath}{c.risk === 'high' && c.status === 'pending' ? ' · needs a careful look' : ''}</div>
            <div className="change-why">{c.reason}</div>
            {c.status === 'pending' ? (
              <div className="change-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void decideChange(c.id, 'accept')}>Accept</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void decideChange(c.id, 'reject')}>Reject</button>
              </div>
            ) : (
              <div className="change-done">
                <span className={`tag ${c.status === 'rejected' ? 'tag-neutral' : 'tag-accent'}`}>{STATUS_LABEL[c.status]}</span>
                {!(c.kind === 'delete' && c.status !== 'rejected') && (
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => void decideChange(c.id, 'undo')}>Undo</button>
                )}
              </div>
            )}
          </div>
        ))}
      </aside>
    </div>
  );
}

function ChangeView({ change: c }: { change: Change }) {
  const ext = c.kind === 'mkdir' || !c.filePath.includes('.') ? '' : c.filePath.split('.').pop()!.toUpperCase();
  let body: React.ReactNode;
  if (c.kind === 'delete') {
    body = <p className="doc-note">{c.status === 'pending' ? 'Accepting moves this file to the Trash. You can put it back from the Trash in Finder.' : c.status === 'rejected' ? 'Kept. The file was not deleted.' : 'Moved to the Trash.'}</p>;
  } else if (c.kind === 'mkdir') {
    body = <p className="doc-note">{c.status === 'pending' ? <>Accepting creates the folder <b>{c.filePath}/</b>.</> : c.status === 'rejected' ? 'Not created.' : <>Created the folder <b>{c.filePath}/</b>.</>}</p>;
  } else if (c.kind === 'move') {
    body = <p className="doc-note">{c.filePath} → <b>{c.moveTo}</b>{c.status === 'pending' ? '. Accepting moves the file; Undo moves it back.' : ''}</p>;
  } else {
    const before = c.before ?? '';
    const after = c.after ?? '';
    if (c.status === 'pending') {
      const parts: DiffPart[] = before.length + after.length > 40_000 ? diffLines(before, after) : diffWordsWithSpace(before, after);
      body = <pre className="doc-text">{parts.map((p, i) => <span key={i} className={p.added ? 'ins' : p.removed ? 'del' : undefined}>{p.value}</span>)}</pre>;
    } else {
      body = <pre className="doc-text">{c.status === 'rejected' ? before : after}</pre>;
    }
  }
  return (
    <>
      <div className="doc-meta">
        <strong>{c.filePath}</strong>
        {ext && <span className="tag tag-neutral">{ext}</span>}
        <span className={`tag ${c.status === 'pending' ? 'tag-accent' : 'tag-neutral'}`}>{c.kind === 'create' ? 'New file' : c.kind === 'mkdir' ? 'New folder' : STATUS_LABEL[c.status]}</span>
      </div>
      <article className="page">{body}</article>
    </>
  );
}

const ACTION_LABEL: Record<FileTouch['action'], string> = { read: 'Read', edited: 'Edited', created: 'Created', moved: 'Moved', deleted: 'Deleted', held: 'Held for review', denied: 'Blocked' };
const ACTION_TONE: Record<FileTouch['action'], string> = { read: 'neutral', edited: 'accent', created: 'outline', moved: 'neutral', deleted: 'accent', held: 'accent', denied: 'outline' };

function FilesTab({ touches }: { touches: FileTouch[] }) {
  const exportAudit = useStore((s) => s.exportAudit);
  return (
    <div className="pane" role="tabpanel" aria-labelledby="tab-files">
      <div className="pane-head">
        <h4>Files Jarvis touched</h4>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => void exportAudit()}>Export audit log</button>
      </div>
      {touches.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No files opened yet.</p> : (
        <table className="table files">
          <thead><tr><th>File</th><th>Action</th><th>Format</th><th>Lane</th><th>Time</th></tr></thead>
          <tbody>
            {touches.map((t, i) => (
              <tr key={i}>
                <td>{t.path}</td>
                <td><span className={`tag tag-${ACTION_TONE[t.action]}`}>{ACTION_LABEL[t.action]}</span></td>
                <td>{t.format}</td>
                <td className="muted">{t.laneTitle}</td>
                <td className="muted nums">{new Date(t.ts).toTimeString().slice(0, 5)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
