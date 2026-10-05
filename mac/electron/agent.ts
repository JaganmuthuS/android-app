// Runs lanes: triage a request, propose a plan, wait for approval, run steps, stop at gates.
import type { Db } from './db';
import type { ChatMessage, Ollama } from './ollama';
import { OllamaError } from './ollama';
import {
  PLAN_INTRO, PLAN_INTRO_AUTO, SUMMARY_INSTRUCTION, TRIAGE_INSTRUCTION, TRIAGE_SCHEMA, parseTriage, stepInstruction, systemPrompt,
} from './prompts';
import type { JarvisEvent, Lane, LaneStatus, Message, PlanStep } from '../shared/types';

export const NEW_LANE_TITLE = 'New lane';
const HISTORY_LIMIT = 24;
const BUSY: LaneStatus[] = ['planning', 'running'];

export class LaneBusyError extends Error {}

export class Agent {
  private controllers = new Map<string, AbortController>();
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private db: Db,
    private ollama: Ollama,
    private emit: (e: JarvisEvent) => void,
    private notify: (title: string, body: string) => void = () => {},
  ) {}

  /** After a crash or quit, nothing is mid-run any more. */
  recover() {
    for (const lane of this.db.listLanes()) {
      if (lane.status === 'planning') this.setStatus(lane.id, 'idle', 'Interrupted · send the request again');
      if (lane.status === 'running') {
        this.db.listSteps(lane.id).filter((s) => s.state === 'running').forEach((s) => this.db.updateStep(s.id, { state: 'queued' }));
        this.setStatus(lane.id, 'paused', 'Paused · app was closed');
      }
    }
  }

  /* ---------- public actions ---------- */

  async send(laneId: string, text: string) {
    const lane = this.mustLane(laneId);
    if (BUSY.includes(lane.status)) throw new LaneBusyError('Jarvis is still working in this lane. Stop it first, or wait for the current step to finish.');
    const clean = text.trim();
    if (!clean) return;
    if (lane.title === NEW_LANE_TITLE) this.db.updateLane(laneId, { title: firstWords(clean) });
    for (const m of this.db.listMessages(laneId)) {
      if (m.kind === 'gate' && m.payload.state === 'pending') this.db.updateMessage(m.id, { ...m.payload, state: 'superseded' });
    }
    this.addMessage(laneId, 'user', 'text', { text: clean });
    this.db.replaceSteps(laneId, []);
    this.emitSteps(laneId);
    this.setStatus(laneId, 'planning', 'Reading the request…', 0);
    await this.task(laneId, (signal) => this.triage(laneId, signal));
  }

  async approvePlan(laneId: string) {
    if (this.mustLane(laneId).status !== 'awaiting_plan_approval') return;
    this.addMessage(laneId, 'system', 'log', { verb: 'Approved', what: 'Plan approved' });
    await this.task(laneId, (signal) => this.run(laneId, signal));
  }

  updatePlan(laneId: string, steps: { text: string; requiresGate: boolean }[]) {
    const lane = this.mustLane(laneId);
    if (lane.status !== 'awaiting_plan_approval') throw new LaneBusyError('Steps can only be edited before the plan is approved.');
    const clean = steps.map((s) => ({ text: s.text.trim(), requiresGate: s.requiresGate })).filter((s) => s.text).slice(0, 12);
    if (!clean.length) throw new LaneBusyError('A plan needs at least one step.');
    this.db.replaceSteps(laneId, clean);
    this.emitSteps(laneId);
  }

  async approveGate(laneId: string) { await this.decideGate(laneId, 'approved'); }
  async skipGate(laneId: string) { await this.decideGate(laneId, 'skipped'); }

  stop(laneId: string) {
    this.controllers.get(laneId)?.abort();
  }

  async resume(laneId: string) {
    const lane = this.mustLane(laneId);
    if (lane.status !== 'paused') return;
    await this.task(laneId, (signal) => this.run(laneId, signal));
  }

  deleteLane(laneId: string) {
    this.stop(laneId);
    this.db.deleteLane(laneId);
    this.emitLanes();
  }

  /* ---------- the work ---------- */

  private async triage(laneId: string, signal: AbortSignal) {
    const settings = this.db.getSettings();
    const history = this.history(laneId);
    const raw = await this.ollama.chat({
      model: settings.model,
      messages: [{ role: 'system', content: systemPrompt(this.db.listMemories()) }, ...history, { role: 'user', content: TRIAGE_INSTRUCTION }],
      format: TRIAGE_SCHEMA,
      temperature: 0.2,
      signal,
    });
    const t = parseTriage(raw);
    const lane = this.mustLane(laneId);
    if (t.title && lane.title === firstWords(String(history.at(-1)?.content ?? ''))) this.db.updateLane(laneId, { title: t.title });

    if (t.kind === 'answer') {
      await this.streamReply(laneId, [{ role: 'system', content: systemPrompt(this.db.listMemories()) }, ...history], signal);
      this.setStatus(laneId, 'idle', 'Answered', 0);
      return;
    }

    this.db.replaceSteps(laneId, t.steps);
    this.emitSteps(laneId);
    const autonomous = lane.autonomy === 'autonomous';
    this.addMessage(laneId, 'jarvis', 'text', { text: autonomous ? PLAN_INTRO_AUTO : PLAN_INTRO });
    this.addMessage(laneId, 'jarvis', 'plan', { scope: t.scope ?? '' });
    if (autonomous) {
      await this.run(laneId, signal);
    } else {
      this.setStatus(laneId, 'awaiting_plan_approval', 'Waiting for plan approval', 0);
      this.notify(this.mustLane(laneId).title, 'The plan is ready for your approval.');
    }
  }

  private async run(laneId: string, signal: AbortSignal) {
    for (;;) {
      const steps = this.db.listSteps(laneId);
      const total = steps.length;
      const next = steps.find((s) => s.state === 'queued' || s.state === 'running');
      if (!next) {
        await this.streamReply(laneId, [...this.context(laneId), { role: 'user', content: SUMMARY_INSTRUCTION }], signal);
        this.setStatus(laneId, 'done', 'Done', 1);
        return;
      }
      if (next.requiresGate && next.note !== 'approved') {
        if (!this.openGate(laneId)) this.addMessage(laneId, 'jarvis', 'gate', { stepId: next.id, text: next.text, state: 'pending' });
        this.setStatus(laneId, 'awaiting_gate', 'Waiting for your approval', progress(steps));
        this.notify(this.mustLane(laneId).title, `Approval needed: ${next.text}`);
        return;
      }
      this.db.updateStep(next.id, { state: 'running' });
      this.emitSteps(laneId);
      this.setStatus(laneId, 'running', `Working · step ${next.index + 1} of ${total}`, progress(steps));
      await this.streamReply(laneId, [...this.context(laneId), { role: 'user', content: stepInstruction(next.index, total, next.text) }], signal, { step: next.index + 1 });
      this.db.updateStep(next.id, { state: 'done' });
      this.addMessage(laneId, 'system', 'log', { verb: 'Done', what: `Step ${next.index + 1} · ${next.text}` });
      this.emitSteps(laneId);
    }
  }

  private async decideGate(laneId: string, decision: 'approved' | 'skipped') {
    if (this.mustLane(laneId).status !== 'awaiting_gate') return;
    const gate = this.openGate(laneId);
    if (!gate) return;
    const stepId = String(gate.payload.stepId);
    this.db.updateMessage(gate.id, { ...gate.payload, state: decision });
    this.emit({ type: 'messages', laneId, messages: this.db.listMessages(laneId) });
    if (decision === 'approved') this.db.updateStep(stepId, { note: 'approved' });
    else this.db.updateStep(stepId, { state: 'skipped', note: 'skipped by you' });
    this.addMessage(laneId, 'system', 'log', { verb: decision === 'approved' ? 'Approved' : 'Skipped', what: String(gate.payload.text) });
    this.emitSteps(laneId);
    await this.task(laneId, (signal) => this.run(laneId, signal));
  }

  /* ---------- helpers ---------- */

  /** Run lane work in a parallel slot, translating stops and errors into lane state. */
  private async task(laneId: string, work: (signal: AbortSignal) => Promise<void>) {
    const ctl = new AbortController();
    this.controllers.get(laneId)?.abort();
    this.controllers.set(laneId, ctl);
    const max = Math.max(1, this.db.getSettings().maxParallel);
    if (this.active >= max) {
      this.setStatus(laneId, this.mustLane(laneId).status === 'planning' ? 'planning' : 'running', 'Queued · waiting for a free slot');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      if (ctl.signal.aborted) throw abortError();
      await work(ctl.signal);
    } catch (e) {
      if (!this.db.getLane(laneId)) return; // lane deleted while running
      const steps = this.db.listSteps(laneId);
      steps.filter((s) => s.state === 'running').forEach((s) => this.db.updateStep(s.id, { state: 'queued' }));
      this.emitSteps(laneId);
      if ((e as Error).name === 'AbortError') {
        const started = steps.some((s) => s.state !== 'queued');
        if (started) this.setStatus(laneId, 'paused', 'Paused · you stopped it', progress(steps));
        else this.setStatus(laneId, 'idle', 'Stopped', 0);
        this.addMessage(laneId, 'system', 'log', { verb: 'Stopped', what: 'You stopped this lane' });
      } else {
        const text = e instanceof OllamaError ? e.message : `Something went wrong: ${(e as Error).message}`;
        this.addMessage(laneId, 'system', 'error', { text });
        this.setStatus(laneId, steps.some((s) => s.state === 'done') ? 'paused' : 'failed', 'Stopped · see the error', progress(steps));
      }
    } finally {
      this.active--;
      if (this.controllers.get(laneId) === ctl) this.controllers.delete(laneId);
      this.waiting.shift()?.();
    }
  }

  private async streamReply(laneId: string, messages: ChatMessage[], signal: AbortSignal, extra: Record<string, unknown> = {}) {
    const msg = this.addMessage(laneId, 'jarvis', 'text', { text: '', streaming: true, ...extra });
    let last = 0;
    let latest = '';
    const flush = () => this.emit({ type: 'stream', laneId, messageId: msg.id, text: latest });
    try {
      const text = await this.ollama.chat({
        model: this.db.getSettings().model,
        messages,
        signal,
        onText: (t) => {
          latest = t;
          const now = Date.now();
          if (now - last > 50) { last = now; flush(); }
        },
      });
      this.db.updateMessage(msg.id, { text: text || '(no reply)', ...extra });
    } catch (e) {
      this.db.updateMessage(msg.id, { text: latest ? `${latest} …` : '', ...extra, interrupted: true });
      throw e;
    } finally {
      this.emit({ type: 'messages', laneId, messages: this.db.listMessages(laneId) });
    }
  }

  /** The conversation as the model sees it: user requests and Jarvis replies. */
  private history(laneId: string): ChatMessage[] {
    return this.db.listMessages(laneId)
      .filter((m) => m.kind === 'text' && (m.role === 'user' || m.role === 'jarvis') && String(m.payload.text ?? '').trim())
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.payload.text) }));
  }

  private context(laneId: string): ChatMessage[] {
    const steps = this.db.listSteps(laneId);
    const plan = steps.map((s) => `${s.index + 1}. ${s.text} [${s.state}]`).join('\n');
    return [
      { role: 'system', content: `${systemPrompt(this.db.listMemories())}\n\nThe approved plan:\n${plan}` },
      ...this.history(laneId),
    ];
  }

  private openGate(laneId: string): Message | undefined {
    return this.db.listMessages(laneId).reverse().find((m) => m.kind === 'gate' && m.payload.state === 'pending');
  }

  private mustLane(laneId: string): Lane {
    const lane = this.db.getLane(laneId);
    if (!lane) throw new LaneBusyError('That lane no longer exists.');
    return lane;
  }

  private setStatus(laneId: string, status: LaneStatus, statusText: string, progressValue?: number) {
    if (!this.db.getLane(laneId)) return;
    this.db.updateLane(laneId, { status, statusText, progress: progressValue });
    this.emitLanes();
  }

  private addMessage(laneId: string, role: Message['role'], kind: Message['kind'], payload: Record<string, unknown>) {
    const m = this.db.addMessage(laneId, role, kind, payload);
    this.emit({ type: 'message', message: m });
    return m;
  }

  emitLanes() { this.emit({ type: 'lanes', lanes: this.db.listLanes() }); }
  private emitSteps(laneId: string) { this.emit({ type: 'steps', laneId, steps: this.db.listSteps(laneId) }); }
}

function progress(steps: PlanStep[]) {
  if (!steps.length) return 0;
  return steps.filter((s) => s.state === 'done' || s.state === 'skipped').length / steps.length;
}

function firstWords(text: string) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  return words.length > 48 ? `${words.slice(0, 47)}…` : words;
}

function abortError() {
  const e = new Error('Stopped');
  e.name = 'AbortError';
  return e;
}
