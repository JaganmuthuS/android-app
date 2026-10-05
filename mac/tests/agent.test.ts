import { describe, expect, it } from 'vitest';
import { Agent } from '../electron/agent';
import { Db } from '../electron/db';
import type { ChatMessage, Ollama } from '../electron/ollama';
import { needsGate, parseTriage } from '../electron/prompts';
import type { JarvisEvent } from '../shared/types';

type ChatOpts = { messages: ChatMessage[]; format?: object; onText?: (t: string) => void; signal?: AbortSignal };

/** A scripted stand-in for the local model. */
function fakeModel(triage: object, opts: { hang?: boolean } = {}) {
  const calls: ChatOpts[] = [];
  const model = {
    async chat(o: ChatOpts) { return (await model.round(o)).content; },
    async round(o: ChatOpts) {
      calls.push(o);
      if (o.format) return { content: JSON.stringify(triage), toolCalls: [] };
      if (opts.hang) {
        await new Promise((_, reject) => o.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
      }
      const last = o.messages.at(-1)!.content;
      const text = last.startsWith('Carry out step') ? `Result for: ${last.split('"')[1]}` : 'Here is the answer.';
      o.onText?.(text);
      return { content: text, toolCalls: [] };
    },
  };
  return { model: model as unknown as Ollama, calls };
}

const PLAN = {
  kind: 'plan', title: 'Board report', scope: 'Finance (read)',
  steps: [{ text: 'Read the figures', gated: false }, { text: 'Draft the summary', gated: false }, { text: 'Email it to the board', gated: false }],
};

function setup(triage: object = PLAN, autonomy: 'ask_every_change' | 'autonomous' = 'ask_every_change', o?: { hang?: boolean }) {
  const db = new Db(':memory:');
  const events: JarvisEvent[] = [];
  const { model, calls } = fakeModel(triage, o);
  const agent = new Agent(db, model, (e) => events.push(e));
  const lane = db.createLane('New lane', autonomy);
  return { db, agent, lane, calls, events };
}

describe('triage parsing', () => {
  it('gates risky steps even when the model forgets to', () => {
    const t = parseTriage(JSON.stringify(PLAN));
    expect(t.kind).toBe('plan');
    expect(t.steps.map((s) => s.requiresGate)).toEqual([false, false, true]);
  });
  it('falls back to a direct answer on bad output', () => {
    expect(parseTriage('not json').kind).toBe('answer');
    expect(parseTriage(JSON.stringify({ kind: 'plan', title: 'x', steps: [{ text: 'one', gated: false }] })).kind).toBe('answer');
  });
  it('recognises gate words', () => {
    expect(needsGate('Delete old drafts', false)).toBe(true);
    expect(needsGate('Summarise the memo', false)).toBe(false);
  });
});

describe('agent', () => {
  it('answers a question directly without a plan', async () => {
    const { db, agent, lane } = setup({ kind: 'answer', title: 'Quick question' });
    await agent.send(lane.id, 'What is 2 + 2?');
    expect(db.getLane(lane.id)).toMatchObject({ status: 'idle', statusText: 'Answered', title: 'Quick question' });
    expect(db.listSteps(lane.id)).toHaveLength(0);
    expect(db.listMessages(lane.id).map((m) => [m.role, m.payload.text])).toEqual([['user', 'What is 2 + 2?'], ['jarvis', 'Here is the answer.']]);
  });

  it('plans, waits for approval, runs, stops at the gate, then finishes', async () => {
    const { db, agent, lane, calls } = setup();
    await agent.send(lane.id, 'Prepare the board report and email it');
    expect(db.getLane(lane.id)).toMatchObject({ status: 'awaiting_plan_approval', title: 'Board report' });
    expect(calls).toHaveLength(1); // nothing runs before approval

    await agent.approvePlan(lane.id);
    let steps = db.listSteps(lane.id);
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'queued']);
    expect(db.getLane(lane.id)).toMatchObject({ status: 'awaiting_gate' });
    const gate = db.listMessages(lane.id).find((m) => m.kind === 'gate')!;
    expect(gate.payload).toMatchObject({ text: 'Email it to the board', state: 'pending' });

    await agent.approveGate(lane.id);
    steps = db.listSteps(lane.id);
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(db.getLane(lane.id)).toMatchObject({ status: 'done', progress: 1 });
    expect(db.listMessages(lane.id).filter((m) => m.kind === 'log').map((m) => m.payload.verb)).toEqual(['Approved', 'Done', 'Done', 'Approved', 'Done']);
  });

  it('can skip a gated step', async () => {
    const { db, agent, lane } = setup();
    await agent.send(lane.id, 'Prepare and email');
    await agent.approvePlan(lane.id);
    await agent.skipGate(lane.id);
    expect(db.listSteps(lane.id).map((s) => s.state)).toEqual(['done', 'done', 'skipped']);
    expect(db.getLane(lane.id)?.status).toBe('done');
  });

  it('runs at once under autonomous, but still stops at gates', async () => {
    const { db, agent, lane } = setup(PLAN, 'autonomous');
    await agent.send(lane.id, 'Prepare and email');
    expect(db.getLane(lane.id)?.status).toBe('awaiting_gate');
  });

  it('lets the user edit steps before approval only', async () => {
    const { db, agent, lane } = setup();
    await agent.send(lane.id, 'Prepare and email');
    agent.updatePlan(lane.id, [{ text: 'Only step', requiresGate: false }, { text: ' ', requiresGate: false }]);
    expect(db.listSteps(lane.id).map((s) => s.text)).toEqual(['Only step']);
    await agent.approvePlan(lane.id);
    expect(db.getLane(lane.id)?.status).toBe('done');
    expect(() => agent.updatePlan(lane.id, [{ text: 'x', requiresGate: false }])).toThrow(/before the plan is approved/);
  });

  it('pauses on stop and resumes from the same step', async () => {
    const { db, agent, lane } = setup(PLAN, 'ask_every_change', { hang: true });
    await agent.send(lane.id, 'Prepare and email');
    const run = agent.approvePlan(lane.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(db.getLane(lane.id)?.status).toBe('running');
    agent.stop(lane.id);
    await run;
    expect(db.getLane(lane.id)).toMatchObject({ status: 'paused' });
    expect(db.listSteps(lane.id).map((s) => s.state)).toEqual(['queued', 'queued', 'queued']);
  });

  it('refuses a new message while the lane is working', async () => {
    const { agent, lane } = setup(PLAN, 'ask_every_change', { hang: true });
    await agent.send(lane.id, 'Prepare and email');
    const run = agent.approvePlan(lane.id);
    await new Promise((r) => setTimeout(r, 10));
    await expect(agent.send(lane.id, 'another')).rejects.toThrow(/still working/);
    agent.stop(lane.id);
    await run;
  });

  it('recovers lanes left running when the app quit', () => {
    const { db, agent, lane } = setup();
    db.replaceSteps(lane.id, [{ text: 'a', requiresGate: false }]);
    db.updateStep(db.listSteps(lane.id)[0].id, { state: 'running' });
    db.updateLane(lane.id, { status: 'running' });
    agent.recover();
    expect(db.getLane(lane.id)?.status).toBe('paused');
    expect(db.listSteps(lane.id)[0].state).toBe('queued');
  });

  it('includes enabled memories in what the model sees', async () => {
    const { db, agent, lane, calls } = setup({ kind: 'answer', title: 'x' });
    db.addMemory('Exact figures, no hedging words');
    await agent.send(lane.id, 'Hi');
    expect(calls[0].messages[0].content).toContain('Exact figures, no hedging words');
  });
});
