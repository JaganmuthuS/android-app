import { CheckpointBar } from './components/CheckpointBar';
import { LaneColumn } from './components/LaneColumn';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { Workspace } from './components/Workspace';

export function App() {
  return (
    <div className="app">
      <TitleBar />
      <main className="body">
        <Sidebar />
        <LaneColumn />
        <Workspace />
      </main>
      <CheckpointBar />
    </div>
  );
}
