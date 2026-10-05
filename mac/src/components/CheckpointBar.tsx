export function CheckpointBar() {
  return (
    <footer className="cpbar">
      <div className="cpbar-label"><h6>Checkpoints</h6></div>
      <div className="timeline">
        <span className="muted" style={{ fontSize: 12 }}>A checkpoint is saved before every step. Click one to roll back.</span>
      </div>
      <div className="cpbar-actions" />
    </footer>
  );
}
