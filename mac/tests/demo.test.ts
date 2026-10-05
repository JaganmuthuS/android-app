import { describe, expect, it } from 'vitest';
import * as demo from '../src/demo';

const approved = (autonomy: demo.Autonomy = 0): demo.DemoState =>
  ({ ...demo.initialState(), autonomy, sent: true, planShown: true, approved: true, running: true });
const runAll = (s: demo.DemoState) => { while (s.step < 4) s = demo.completeStep(s); return s; };

describe('board report walkthrough', () => {
  it('touches nothing before the plan is approved', () => {
    const s = { ...demo.initialState(), sent: true, planShown: true };
    expect(demo.files(s).map((f) => f.path)).toEqual(['Legal/Acme-MSA-v3.docx']);
    expect(demo.availableChanges(s)).toHaveLength(0);
    expect(demo.checkpoints(s)).toHaveLength(0);
    expect(demo.lanes(s)[0].status).toBe('Waiting for plan approval');
  });

  it('plans 5 steps with the export gated', () => {
    const steps = demo.planSteps(approved());
    expect(steps).toHaveLength(5);
    expect(steps[4]).toMatchObject({ text: 'Export PDF to Board/Out', state: 'gate', note: 'needs your approval' });
  });

  it('holds every change for review under "ask every change"', () => {
    const s = runAll(approved(0));
    expect(s.running).toBe(false);
    expect(demo.pendingCount(s)).toBe(4);
    expect(demo.lanes(s)[0].status).toBe('4 changes to review');
    expect(demo.approveExport(s).exportOk).toBe(false);
    expect(demo.gateNote(s)).toBe('Review 4 open changes first');
  });

  it('unblocks the export only once every change is decided', () => {
    let s = runAll(approved(0));
    s = demo.decide(s, 'c2', 'rejected');
    s = demo.acceptAll(s);
    expect(demo.pendingCount(s)).toBe(0);
    s = demo.approveExport(s);
    expect(demo.isDone(s)).toBe(true);
    expect(demo.files(s).some((f) => f.path === 'Board/Out/Q3-Board.pdf')).toBe(true);
  });

  it('auto-applies changes when autonomy is not "ask every change"', () => {
    const s = runAll(approved(1));
    expect(demo.pendingCount(s)).toBe(0);
    expect(Object.values(s.dec)).toEqual(['auto', 'auto', 'auto', 'auto']);
    expect(s.exportOk).toBe(false);
    expect(runAll(approved(2)).exportOk).toBe(true);
  });

  it('shows inline diffs while pending and the chosen text once decided', () => {
    let s = demo.completeStep(demo.completeStep(approved(0)));
    const text = (st: demo.DemoState) => demo.summarySegments(st).map((g) => g.t).join('');
    expect(demo.summarySegments(s).filter((g) => g.look !== 'plain').map((g) => g.look)).toEqual(['del', 'ins', 'del', 'ins', 'ins']);
    s = demo.decide(s, 'c1', 'accepted');
    s = demo.decide(s, 'c2', 'rejected');
    s = demo.decide(s, 'c3', 'rejected');
    expect(text(s)).toBe('Net revenue for the quarter was €4.82M, slightly ahead of the forecast set in June. Gross margin held at 61%. Cash runway remains above 20 months.');
  });

  it('restores to a checkpoint, dropping later decisions', () => {
    let s = runAll(approved(0));
    s = demo.acceptAll(s);
    expect(demo.checkpoints(s).map((c) => c.label)).toEqual(['Before edits', 'Read Sept-close', 'Table 2 updated', 'Research merged', 'Drafted 4.2']);
    s = { ...s, cpSel: 0 };
    expect(demo.canRestore(s)).toBe(true);
    s = demo.restore(s);
    expect(s.step).toBe(0);
    expect(s.dec).toEqual({});
    expect(s.restored).toBe(true);
    expect(demo.section42(s)).toBe('placeholder');
  });

  it('keeps decisions made before the restored checkpoint', () => {
    let s = runAll(approved(0));
    s = demo.acceptAll(s);
    s = demo.restore({ ...s, cpSel: 2 });
    expect(Object.keys(s.dec).sort()).toEqual(['c1', 'c2', 'c3']);
  });
});
