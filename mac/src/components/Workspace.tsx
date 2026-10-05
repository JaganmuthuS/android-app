import type { UiState } from '../../shared/types';
import { useStore } from '../store';

const TABS: { id: UiState['tab']; label: string }[] = [
  { id: 'doc', label: 'Document' },
  { id: 'research', label: 'Research' },
  { id: 'files', label: 'Files' },
];

export function Workspace() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);

  return (
    <section className="col" aria-label="Workspace">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} className="plain-btn tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'doc' && (
        <div className="doc-split" role="tabpanel" aria-labelledby="tab-doc">
          <div className="doc-pane">
            <div className="empty-state">
              <h5>No document open</h5>
              <p>When Jarvis edits a Word, Excel, PowerPoint or PDF file, the document appears here with every change marked inline. File editing arrives in a later update.</p>
            </div>
          </div>
          <aside className="rail" aria-label="Changes">
            <div className="rail-head"><h6 style={{ margin: 0 }}>Changes · 0 open</h6></div>
            <p className="rail-empty">Nothing edited yet. Every change Jarvis makes lands here first, with the reason and the source.</p>
          </aside>
        </div>
      )}
      {tab === 'research' && (
        <div className="pane" role="tabpanel" aria-labelledby="tab-research">
          <div className="empty-state">
            <h5>No sources yet</h5>
            <p>Research lanes will list every source Jarvis reads, numbered, with whether it was cited and why. Web research arrives in a later update.</p>
          </div>
        </div>
      )}
      {tab === 'files' && (
        <div className="pane" role="tabpanel" aria-labelledby="tab-files">
          <div className="pane-head">
            <h4>Files Jarvis touched</h4>
            <span className="muted" style={{ fontSize: 13 }}>This session · all reversible</span>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>No files opened yet.</p>
        </div>
      )}
    </section>
  );
}
