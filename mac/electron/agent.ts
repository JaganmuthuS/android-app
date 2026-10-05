// Runs lanes: triage a request, propose a plan, wait for approval, run steps with file tools, stop at gates.
import type { Db } from './db';
import type { ChatMessage, Ollama } from './ollama';
import { OllamaError } from './ollama';
import {
  MAX_TOOL_ROUNDS, PLAN_INTRO, PLAN_INTRO_AUTO, SUMMARY_INSTRUCTION, TOOLS, TRIAGE_INSTRUCTION, TRIAGE_SCHEMA,
  parseTriage, stepInstruction, systemPrompt, workspaceSummary,
} from './prompts';
import { ScopeError, type Workspace } from './workspace';
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
    private workspace: Workspace | null = null,
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
    this.supersedeGates(laneId);
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

  async approveGate(laneId: string) {
    const open = this.pendingChanges(laneId);
    if (open) throw new LaneBusyError(`Review ${open} open change${open > 1 ? 's' : ''} first.`);
    await this.decideGate(laneId, 'approved');
  }
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

  /** Called after the user accepts, rejects or undoes a change. */
  changesUpdated(laneId: string) {
    const lane = this.db.getLane(laneId);
    if (!lane) return;
    const open = this.pendingChanges(laneId);
    if (lane.status === 'awaiting_review' && !open) this.setStatus(laneId, 'done', 'Done', 1);
    else if (lane.status === 'awaiting_review') this.setStatus(laneId, 'awaiting_review', reviewText(open), lane.progress);
  }

  async restoreCheckpoint(checkpointId: string) {
    if (!this.workspace) throw new LaneBusyError('No workspace folder is set.');
    const cp = this.db.getCheckpoint(checkpointId);
    if (!cp) throw new LaneBusyError('That checkpoint no longer exists.');
    if (BUSY.includes(this.mustLane(cp.laneId).status)) throw new LaneBusyError('Stop the lane before restoring a checkpoint.');
    const { laneId, stepIndex, label } = await this.workspace.restore(checkpointId);
    const steps = this.db.listSteps(laneId);
    steps.filter((s) => s.index >= stepIndex).forEach((s) => this.db.updateStep(s.id, { state: 'queued', note: null }));
    this.supersedeGates(laneId);
    this.emitSteps(laneId);
    this.addMessage(laneId, 'system', 'log', { verb: 'Restored', what: `Files are back to ${label}. A checkpoint of the state before the restore was saved.` });
    const after = this.db.listSteps(laneId);
    if (after.length) this.setStatus(laneId, 'paused', `Restored to ${label}`, progress(after));
    else this.setStatus(laneId, 'idle', `Restored to ${label}`, 0);
    this.emit({ type: 'checkpoints', laneId, checkpoints: this.db.listCheckpoints(laneId) });
  }

  /* ---------- the work ---------- */

  private async triage(laneId: string, signal: AbortSignal) {
    const settings = this.db.getSettings();
    const history = this.history(laneId);
    const raw = await this.ollama.chat({
      model: settings.model,
      messages: [{ role: 'system', content: this.system() }, ...history, { role: 'user', content: TRIAGE_INSTRUCTION }],
      format: TRIAGE_SCHEMA,
      temperature: 0.2,
      signal,
    });
    const t = parseTriage(raw);
    const lane = this.mustLane(laneId);
    if (t.title && lane.title === firstWords(String(history.at(-1)?.content ?? ''))) {
      this.db.updateLane(laneId, { title: t.title });
      this.emitLanes();
    }

    if (t.kind === 'answer') {
      await this.respond(laneId, [{ role: 'system', content: this.system() }, ...history], signal, null);
      const open = this.pendingChanges(laneId);
      if (open) this.setStatus(laneId, 'awaiting_review', reviewText(open), 0);
      else this.setStatus(laneId, 'idle', 'Answered', 0);
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
        await this.respond(laneId, [...this.context(laneId), { role: 'user', content: SUMMARY_INSTRUCTION }], signal, null, false);
        const open = this.pendingChanges(laneId);
        if (open) {
          this.setStatus(laneId, 'awaiting_review', reviewText(open), 1);
          this.notify(this.mustLane(laneId).title, `${reviewText(open)}.`);
        } else {
          this.setStatus(laneId, 'done', 'Done', 1);
        }
        return;
      }
      if (next.requiresGate && next.note !== 'approved') {
        if (!this.openGate(laneId)) this.addMessage(laneId, 'jarvis', 'gate', { stepId: next.id, text: next.text, state: 'pending' });
        this.setStatus(laneId, 'awaiting_gate', 'Waiting for your approval', progress(steps));
        this.notify(this.mustLane(laneId).title, `Approval needed: ${next.text}`);
        return;
      }
      if (next.state === 'queued' && this.workspace?.root()) {
        this.db.addCheckpoint(laneId, next.index, next.index === 0 ? 'Before edits' : `Before step ${next.index + 1}`);
        this.emit({ type: 'checkpoints', laneId, checkpoints: this.db.listCheckpoints(laneId) });
      }
      this.db.updateStep(next.id, { state: 'running' });
      this.emitSteps(laneId);
      this.setStatus(laneId, 'running', `Working · step ${next.index + 1} of ${total}`, progress(steps));
      await this.respond(laneId, [...this.context(laneId), { role: 'user', content: stepInstruction(next.index, total, next.text) }], signal, next.index, true, { step: next.index + 1 });
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

  /**
   * One reply from the model, with file tools when a workspace is set. Text streams into a
   * single chat message; every tool call is logged in the chat and the audit log.
   */
  private async respond(laneId: string, messages: ChatMessage[], signal: AbortSignal, stepIndex: number | null, useTools = true, extra: Record<string, unknown> = {}) {
    const msg = this.addMessage(laneId, 'jarvis', 'text', { text: '', streaming: true, ...extra });
    const tools = useTools && this.workspace?.root() ? TOOLS : undefined;
    const convo = [...messages];
    let last = 0;
    let latest = '';
    const flush = () => this.emit({ type: 'stream', laneId, messageId: msg.id, text: latest });
    const deniedScopes = new Set<string>();
    try {
      for (let round = 0; ; round++) {
        const res = await this.ollama.round({
          model: this.db.getSettings().model,
          messages: convo,
          signal,
          tools: round < MAX_TOOL_ROUNDS ? tools : undefined,
          onText: (t) => {
            latest = t;
            const now = Date.now();
            if (now - last > 50) { last = now; flush(); }
          },
        });
        if (!res.toolCalls.length || !tools) {
          latest = res.content || latest;
          break;
        }
        convo.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          if (signal.aborted) throw abortError();
          const name = call.function.name;
          const args = (typeof call.function.arguments === 'string' ? safeJson(call.function.arguments) : call.function.arguments) ?? {};
          let result: string;
          try {
            const out = await this.workspace!.exec(name, args, { laneId, stepIndex, autonomy: this.mustLane(laneId).autonomy });
            result = out.result;
            if (out.log) this.addMessage(laneId, 'system', 'log', { verb: out.log[0], what: out.log[1] });
          } catch (e) {
            result = `ERROR: ${(e as Error).message}`;
            if (e instanceof ScopeError && !deniedScopes.has(e.scopePath)) {
              deniedScopes.add(e.scopePath);
              this.addMessage(laneId, 'system', 'error', { text: e.message, grantPath: e.scopePath, grantMode: e.needs });
            } else if (!(e instanceof ScopeError)) {
              this.addMessage(laneId, 'system', 'log', { verb: 'Failed', what: `${name} · ${(e as Error).message}` });
            }
          }
          convo.push({ role: 'tool', content: result, tool_name: name });
        }
        latest = '';
      }
      this.db.updateMessage(msg.id, { text: latest || '(no reply)', ...extra });
    } catch (e) {
      this.db.updateMessage(msg.id, { text: latest ? `${latest} …` : '', ...extra, interrupted: true });
      throw e;
    } finally {
      this.emit({ type: 'messages', laneId, messages: this.db.listMessages(laneId) });
    }
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

  private system() {
    const root = this.workspace?.root() ?? null;
    const scopes = root ? this.workspace!.syncScopes() : [];
    return systemPrompt(this.db.listMemories(), new Date(), workspaceSummary(root, scopes));
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
      { role: 'system', content: `${this.system()}\n\nThe approved plan:\n${plan}` },
      ...this.history(laneId),
    ];
  }

  private pendingChanges(laneId: string) {
    return this.db.listChanges(laneId).filter((c) => c.status === 'pending').length;
  }

  private supersedeGates(laneId: string) {
    for (const m of this.db.listMessages(laneId)) {
      if (m.kind === 'gate' && m.payload.state === 'pending') this.db.updateMessage(m.id, { ...m.payload, state: 'superseded' });
    }
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

const reviewText = (n: number) => `${n} change${n > 1 ? 's' : ''} to review`;

function firstWords(text: string) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  return words.length > 48 ? `${words.slice(0, 47)}…` : words;
}

function safeJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}

function abortError() {
  const e = new Error('Stopped');
  e.name = 'AbortError';
  return e;
}
