import { api } from './api';
import { CheckpointBar } from './components/CheckpointBar';
import { LaneColumn } from './components/LaneColumn';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { Workspace } from './components/Workspace';
import { useStore } from './store';

export function App() {
  const ready = useStore((s) => s.ready);
  const toast = useStore((s) => s.toast);

  if (!api) {
    return <div className="not-app"><h4>JARVIS</h4><p>This screen only works inside the JARVIS Mac app.</p></div>;
  }
  return (
    <div className="app">
      <TitleBar />
      <main className="body">
        <Sidebar />
        {ready ? <LaneColumn /> : <section className="col" />}
        <Workspace />
      </main>
      <CheckpointBar />
      <SettingsDialog />
      {toast && <div className="toast" role="alert">{toast}</div>}
    </div>
  );
}
