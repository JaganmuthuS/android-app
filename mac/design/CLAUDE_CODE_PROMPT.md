# Build JARVIS — a macOS desktop agent for documents, folders and research

You are building a production-quality macOS desktop app called **JARVIS**. The user chats with it, and it does work on local files and folders: it reads and edits Word, Excel, PowerPoint and PDF files while keeping their formatting, organises folders, and researches online with citations. It can run several tasks in parallel. **It never changes a file without a reviewable diff, and it never acts outside the folders the user granted.**

The attached `JARVIS Workspace.dc.html` is the interactive design reference. Match its layout, copy tone and behaviour exactly. The visual tokens are listed in section 9.

Work in phases (section 11). At the end of each phase: run the app, run the tests, and commit.

---

## 1. Tech stack (use exactly this unless blocked)

- **Shell:** Electron (latest stable) + TypeScript, packaged with `electron-builder` as a signed, notarised `.dmg` (universal: arm64 + x64).
- **UI:** React 18 + Vite + TypeScript. Use plain CSS with CSS variables from section 9 (no Tailwind, no component library). Icons: `lucide-react`.
- **State:** Zustand in the renderer. The main process is the source of truth for tasks, files and checkpoints. Use typed IPC via `contextBridge` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **Agent runtime:** `@anthropic-ai/claude-agent-sdk` (TypeScript) in the main process (or a utility process per lane). The model is configurable in Settings; default to the latest Claude Sonnet. Make the API key a field in Settings and store it in the macOS Keychain (`keytar` or `safeStorage`). Never write it to disk in plain text.
- **Storage:** SQLite (`better-sqlite3`) at `~/Library/Application Support/JARVIS/jarvis.db`.
- **File formats:**
  - DOCX: `docx` (write) + `mammoth`/`jszip` + direct OOXML editing for tracked changes (`w:ins` / `w:del`) so styles survive.
  - XLSX: `exceljs` (preserve styles, formulas and named ranges; never flatten formulas).
  - PPTX: `jszip` + OOXML editing for existing decks; `pptxgenjs` for new decks.
  - PDF: `pdfjs-dist` (read and extract), `pdf-lib` (annotate, fill forms, merge). DOCX→PDF export goes through LibreOffice headless if installed, otherwise a built-in renderer. Detect and tell the user which one is used.
  - Markdown, CSV, TXT, JSON: native.
- **Web research:** the Anthropic server-side web search and web fetch tools, through the SDK. Every claim used in a document must carry a source.
- **Voice:** push-to-talk using `MediaRecorder` → transcription (pluggable: local `whisper.cpp` binary or an API). Show a live "Listening…" state.
- **Scheduling:** `node-cron` in the main process. Jobs persist in SQLite and run while the app (or its menu-bar helper) is alive.
- **Watching folders:** `chokidar`.
- **Tests:** Vitest (unit) + Playwright for Electron (e2e).

---

## 2. Core concepts and data model

```ts
type AutonomyLevel = 'ask_every_change' | 'ask_if_risky' | 'autonomous';

interface Lane {            // one parallel task = one agent session
  id: string; title: string;
  status: 'idle'|'planning'|'awaiting_plan_approval'|'running'|'paused'
        |'awaiting_review'|'awaiting_gate'|'done'|'failed'|'scheduled';
  progress: number;         // 0..1, derived from plan steps
  createdAt: number; updatedAt: number;
  sessionId?: string;       // Agent SDK session for resume
  schedule?: string;        // cron, for background jobs
}
interface Message { id; laneId; role: 'user'|'jarvis'|'system';
  kind: 'text'|'plan'|'log'|'gate'|'error'; payload: any; ts: number; }
interface PlanStep { id; laneId; index; text; state: 'queued'|'running'|'done'|'failed'|'skipped';
  requiresGate: boolean; note?: string; }
interface FileScope { path: string; mode: 'none'|'read'|'edit_ask'|'edit_auto'; }
interface Change {          // one reviewable unit
  id; laneId; stepId; filePath; format: 'docx'|'xlsx'|'pptx'|'pdf'|'text'|'fs';
  title: string;            // "Net revenue €4.61M → €4.82M"
  reason: string;           // why, citing source cell/file/memory
  sourceRefs: SourceRef[];
  patch: FormatPatch;       // format-specific, applied to a shadow copy
  status: 'pending'|'accepted'|'rejected'|'auto_applied';
  risk: 'low'|'high';
}
interface Checkpoint { id; laneId; stepIndex; label; ts; snapshotIds: string[]; }
interface Source { id; laneId; n: number; title; url?: string; localPath?: string;
  kind: 'primary'|'secondary'|'internal'; note: string; state: 'queued'|'read'|'cited'|'not_cited'; reasonNotCited?: string; }
interface Memory { id; text; scope: 'global'|'workspace'; createdFrom?: messageId; enabled: boolean; }
interface FileTouch { laneId; path; action: 'read'|'edited'|'created'|'moved'|'deleted'|'held'; format; ts; }
```

---

## 3. Exact behaviour (the flow from the prototype)

### 3.1 Sending a request
1. The user types in the composer (Return sends, Shift+Return adds a new line) or holds the mic button. `@` opens a picker for files, folders and other lanes; picked items show as chips above the input and are attached as context.
2. The lane status becomes `planning`, and the chat shows a pulsing accent square with the text "Reading the request and checking folder access…".
3. The agent produces a **plan before touching anything**. The plan is a list of 3–8 numbered steps plus a scope line (e.g. "Scope: Finance (read) · Board (write)"). Any step that sends, exports outside the working folder, deletes, emails or overwrites originals has `requiresGate: true` and is shown with an accent-outlined square and the note "needs your approval".
4. Under `ask_every_change` and `ask_if_risky`, the plan card shows **Approve plan** (primary) and **Edit steps** (secondary). Edit steps makes each step editable inline: reorder, delete, add. Under `autonomous`, the plan starts immediately.

### 3.2 Running
- Steps run in order. The current step pulses (accent fill). Done steps turn to solid ink, and their text drops to neutral-700.
- **Before each step, create a checkpoint**: snapshot every file the step may write into a content-addressed store at `~/Library/Application Support/JARVIS/snapshots/<sha256>`. The checkpoint bar at the bottom gains a node labelled `HH:MM · <label>`.
- After each step, append a **log line** to the chat: verb + object, e.g. `Edited  Q3-Board.docx · Table 2, 4 cells · 3 wording edits held for review`.
- Every file read or write is recorded as a `FileTouch` (Files tab).
- The agent **never writes the original file directly**. It writes to a shadow copy in `.jarvis/shadow/` and emits `Change` records. Originals are updated only when changes are accepted (or auto-applied).

### 3.3 Review (Document tab)
- The centre-right pane renders the active document with **inline diffs**: insertions use an accent-100 background, accent-800 text and an accent underline; deletions are neutral-600 with a strikethrough and 4px of spacing before the insertion. Changed table cells get an accent-100 fill.
- The right rail is titled "Changes · N open" and lists each Change with its title, reason (always citing a source cell, file, or memory item) and **Accept** / **Reject**. Once decided, it shows a tag (Accepted / Rejected / Auto-applied) plus **Undo**. "Accept all" appears when more than one change is open.
- The document re-renders as decisions are made: accepted → shows the new text plain; rejected → shows the original.
- Autonomy rules:
  - `ask_every_change`: every change is pending.
  - `ask_if_risky`: `risk: 'low'` changes are auto-applied (still listed with Undo); high-risk ones stay pending. High risk means numbers in legal or financial documents, clause text, deletions, anything over 200 changed characters, or anything in a folder marked `edit_ask`.
  - `autonomous`: all auto-applied, except gates (see below) when the folder scope is `edit_ask`.
- Rendering: DOCX → HTML via a custom OOXML walker that keeps paragraph styles, headings, tables and tracked-change marks. XLSX → a sheet grid with changed cells highlighted. PPTX → slide thumbnails plus a text diff per shape. PDF → `pdfjs` canvas with an overlay for annotations.

### 3.4 Gates
- When a gated step is reached, the lane status becomes `awaiting_gate` and the chat shows a red-bordered card on accent-100 titled **APPROVAL NEEDED**, describing exactly what will happen (e.g. "Export Q3-Board.docx to Board/Out/Q3-Board.pdf. This is the first file that leaves the working draft.").
- **Approve export** stays disabled while any change in the lane is pending. The note next to it reads "Review N open changes first".
- On approval: run the step, log it (`Exported  Board/Out/Q3-Board.pdf · 12 pages · fonts embedded`), and finish with a short question about the next action. Never send anything without asking.

### 3.5 Checkpoints and restore
- Clicking a checkpoint selects it (accent dot, accent-100 background), and **Restore to HH:MM** appears on the right of the bar.
- Restoring writes the snapshots back, discards Changes created after that checkpoint, sets the lane back to that step, and shows **Resume from step N** in the plan card. Restore can itself be undone (it creates its own checkpoint first).

### 3.6 Parallel lanes
- The left column lists lanes. Each row has a 4px accent bar when selected, the title, a status line and a 2px progress bar (ink, or accent when it is waiting on the user).
- Each lane is an independent Agent SDK session in its own utility process, with at most 4 running at once (configurable); extra lanes queue.
- Lanes can reference each other ("Pull findings from lane 2"). Expose an internal tool `read_lane_output(laneId)` that returns that lane's latest summary and sources.
- "+ New lane" starts an empty lane. A lane waiting on the user shows a macOS notification.
- The title bar shows "N lanes active", the workspace path, and the autonomy segmented control (a global default; each lane can override it).

### 3.7 Research (Research tab)
- Header: the topic, which channels are being searched (web, specific sites, local folders) and a tag such as "9 of 14 read".
- Numbered sources: a large accent numeral, the title, the origin (domain + "primary law" / "secondary" / "internal"), and a one-line note. Each has a state tag: Read, Cited in §4.2, or Not cited (with the reason, e.g. "figures are not sourced").
- Text inserted into a document carries citation markers `[n]` that map to this list. DOCX output uses real footnotes.
- Primary sources rank above secondary ones. Local folder content counts as an internal source.

### 3.8 Folder access (permission scopes)
- The left column lists scopes with tags: Read only (neutral), Edit · ask (accent), No access (outline).
- Enforce these in the main process: every agent file tool goes through `assertScope(path, op)`. Paths are resolved with `realpath`, so symlink escapes are blocked. A violation fails the tool call and posts a system message offering to grant access.
- First run: the user picks a workspace folder (security-scoped bookmark if the app is sandboxed). Everything else is `none` by default.

### 3.9 Memory
- The "Remembers" list in the left column. Jarvis proposes a memory when the user corrects it ("Noted. Should I remember: prefer exact figures over hedging words?"), and it is saved only on confirmation. Memories can be edited, disabled or deleted in Settings.
- Active memories are injected into each lane's system prompt. When a memory causes a change, the change's reason cites it ("Memory: you prefer exact figures…").

### 3.10 Background and scheduled jobs
- Any lane can be given a schedule ("every day at 18:00"). Scheduled lanes show "Scheduled · daily 18:00" and run with the lane's autonomy level. Their results land as a summary card plus a notification.
- Built-in example: "File ~/Downloads" sorts files into folders by type and content, and puts anything it can't classify in `Downloads/Review`.

### 3.11 Summon from anywhere
- Menu-bar tray icon + global shortcut **⌥ Space** opens a floating quick-ask panel (560px wide). It uses the same composer, works with the active Finder selection (via AppleScript), and creates or continues a lane.
- Hold-to-talk works in the panel too.

### 3.12 Other lanes view
- Selecting a non-active lane replaces the chat with a summary card: kicker = status, body = latest summary, meta = "Updated X ago". Below it: a "Back to …" secondary button.

---

## 4. Agent tools (register as custom SDK tools; all go through scope + shadow + checkpoint)

`list_dir`, `read_file` (format-aware text + structure), `search_files` (name + content), `docx_edit` (ops: replace_text, insert_paragraph, update_table_cell, add_footnote; output is tracked changes), `xlsx_read_range`, `xlsx_write_cells`, `pptx_edit_shape_text`, `pdf_extract`, `pdf_annotate`, `export_pdf` (gated), `move_file` / `rename_file` (soft, reversible), `delete_file` (moves to Trash; gated), `create_file`, `read_lane_output`, `propose_memory`, plus the server-side `web_search` and `web_fetch`.

Each write tool returns `Change` objects rather than mutating originals. The system prompt must require: make a plan first; cite a source for every number and claim; keep the document's template and styles; no hedging words; ask instead of guess when the request is ambiguous.

---

## 5. Copy tone
Neutral and professional. Short sentences. Exact figures. No exclamation marks, no emoji, no butler persona. Examples to reuse verbatim:
- "Here is my plan. I will not touch any file until you approve it, and every edit will wait in the change list for review."
- "Table 2 is updated. Net revenue was €4.82M, 3.1% above the June forecast. I left three wording changes in the document for you to review instead of rewriting your paragraph."
- "Nothing edited yet. Every change Jarvis makes lands here first, with the reason and the source."
- "A checkpoint is saved before every step. Click one to roll back."

---

## 6. Layout (1440×900 default window; minimum 1180×720)
- **Title bar (52px):** native traffic lights, wordmark "JARVIS" (Archivo 800, 18px, 0.04em tracking) + an 8px accent square | workspace path + lanes tag | "AUTONOMY" label + 3-option segmented control (selected = ink fill, bg-coloured text).
- **Body grid:** `260px | 480px | 1fr`, separated by 2px dividers.
  - Left: Task lanes → (bottom-anchored) Folder access → Remembers.
  - Middle: lane header (accent-700 kicker "LANE N", 20px heading) → scrolling chat that auto-scrolls to the newest item → composer (context chips, textarea, mic icon button, primary send icon button, hint line "Return to send · ⌥ Space summons Jarvis from the menu bar in any app").
  - Right: tabs Document / Research / Files (active = 3px accent underline, with a count beside each) → content. The Document tab is split `1fr | 270px` (page | Changes rail).
- **Checkpoint bar (60px):** "CHECKPOINTS" label cell (260px) | the timeline of nodes linked by 2px neutral connectors | Restore button.
- Window state, the selected lane and the selected tab persist across launches.

## 7. User messages, Jarvis messages, plan, log, gate: visual specs
- User message: right-aligned, max 85% width, ink fill, bg-coloured text, 12/14 padding.
- Jarvis text: an 11px uppercase "JARVIS" label above 14px body text, max 92% width.
- Plan card: 2px ink border, a header row with "PLAN · x of y", and rows separated by 1px neutral-300 lines with a 10px state square.
- Log line: a 2px neutral-400 left border, a bold verb (min-width 56px), 12px neutral-800 text.
- Gate card: a 2px accent border on accent-100, an uppercase accent-800 header, accent-900 body text.

## 8. Accessibility and quality
- Full keyboard support: ⌘N new lane, ⌘1–9 switch lanes, ⌘↵ approve the focused plan or gate, A / R accept or reject the focused change, ⌘Z undoes the last decision.
- Focus ring: `outline: 2px solid var(--color-accent); outline-offset: 2px`. Disabled elements use 45% opacity.
- Body text contrast ≥ 4.5:1. Never use accent-500 for paragraph text; use accent-700.
- Agent output streams token by token. Long operations show the current step in the pulsing "thinking" row.

## 9. Design tokens (Modernist — zero radius, 2px rules, Archivo only, flush-left everything)
```css
:root{
  --color-bg:#f3f2f2; --color-surface:#eae9e9; --color-text:#201e1d;
  --color-accent:#ec3013; --color-divider:color-mix(in srgb,#201e1d 40%,transparent);
  --color-neutral-100:#f8f4f4; --color-neutral-200:#eae7e7; --color-neutral-300:#d7d3d3;
  --color-neutral-400:#bab6b6; --color-neutral-500:#9b9797; --color-neutral-600:#7d7979;
  --color-neutral-700:#605d5d; --color-neutral-800:#444141; --color-neutral-900:#2d2b2b;
  --color-accent-100:#fff2ef; --color-accent-200:#ffe0d9; --color-accent-300:#ffc4b8;
  --color-accent-400:#ff9783; --color-accent-500:#ff563c; --color-accent-600:#dd2b0f;
  --color-accent-700:#ae1800; --color-accent-800:#7c1405; --color-accent-900:#4d170e;
  --font-heading:"Archivo",system-ui,sans-serif; --font-heading-weight:800;
  --font-body:"Archivo",system-ui,sans-serif;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-6:24px; --space-8:32px;
  --radius-sm:0; --radius-md:0; --radius-lg:0;
  --shadow-sm:0 1px 2px color-mix(in srgb,#2d2b2b 14%,transparent);
  --shadow-md:0 3px 10px color-mix(in srgb,#2d2b2b 16%,transparent);
  --shadow-lg:0 12px 32px color-mix(in srgb,#2d2b2b 22%,transparent);
}
```
Bundle Archivo (400/600/800) locally. Buttons: primary = accent fill (hover accent-600, active accent-700); secondary = 1px divider border (hover ink at 7%); ghost = accent text. Labels are always flush left. Tags: 11px, 3px/10px padding; neutral = neutral-100/800, accent = accent-100/800, outline = 1px accent. Base text 15px/1.55; h6 = 13px uppercase, 0.08em tracking.

## 10. Security and privacy
- Hardened runtime, notarisation, strict CSP, no remote code. Agent processes cannot reach the filesystem except through the scoped tools.
- Network access is limited to the Anthropic API and the URLs the research tools fetch. Log every outbound request in Settings → Activity.
- A local audit log of every tool call (who, what, which path, result) can be exported as CSV.
- Settings → "Delete all local data".

## 11. Build phases (commit after each; each must run end-to-end)
1. Electron + React shell, layout from section 6 with mock data matching the prototype, tokens, persistence.
2. SQLite models, lanes, chat streaming with the Agent SDK, plan generation + approval, autonomy levels.
3. Scoped file tools, shadow copies, checkpoints + restore, Files tab, audit log.
4. Format engines: DOCX tracked changes + renderer, XLSX, PPTX, PDF; the Changes rail with accept, reject and undo.
5. Research tab: web search/fetch, source list, citations into DOCX footnotes; cross-lane reads.
6. Gates, macOS notifications, memory proposals, scheduler + the Downloads job.
7. Menu bar + ⌥ Space quick panel, voice input, Finder selection.
8. Keyboard shortcuts, accessibility pass, e2e tests for the full board-report flow (send → approve plan → 4 steps → review 4 changes → gate → export → restore → resume), signing + DMG.

## 12. Acceptance test (must pass)
With a sample workspace containing `Finance/Sept-close.xlsx`, `Board/Q3-Board.docx` (with a custom style template) and `Legal/AI-Act-memo.pdf`, under `ask_every_change`:
- Sending the board-report request produces a 5-step plan with a gated export, and no file is touched before approval.
- After approval, `Q3-Board.docx` is unchanged on disk until changes are accepted. Accepted changes appear as real Word tracked changes, and styles are byte-identical outside the edited runs.
- Export stays blocked while any change is pending.
- Restoring to the "Before edits" checkpoint returns all files to their original SHA-256.
- A write attempt to `Personal/` fails with a scope error message.
