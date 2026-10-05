# JARVIS for Mac

A desktop agent for documents, folders and research, built from `CLAUDE_CODE_PROMPT.md` and the `JARVIS Workspace` design.

## Status: Phase 3 of 8

**New in Phase 3: files**
- **Workspace**: click "Workspace" in the title bar to choose the folder Jarvis works in.
- **Folder access**: every folder inside starts at **No access**. Set each one in the left column to **Read only**, **Edit · ask** (every change waits for you) or **Edit · auto** (your autonomy level decides). Access is checked in the main process for every file action, with symlinks resolved first, so a link can't reach outside the workspace or into a closed folder.
- **File tools**: Jarvis can list folders, read and search files, and create, edit, move or delete files. It reads text, Markdown, CSV, JSON and Word (.docx) files and edits text and Markdown files. Excel, PowerPoint and PDF support, and Word editing, come in Phase 4.
- **Changes, not overwrites**: every edit is staged as a change with an inline word-by-word diff in the Document tab, plus the reason and the source. **Accept**, **Reject** and **Undo** each change, or **Accept all**. Under "Ask if risky", small low-risk edits apply at once. Figures in finance or legal files, big edits and anything in an "Edit · ask" folder still wait. Deletions always wait and go to the Trash.
- **Approval gates** stay blocked while any change in the lane is open.
- **Checkpoints**: Jarvis saves one before every step and keeps copies of every file it changes. Click a checkpoint and **Restore** to put the files back; the restore saves its own checkpoint first, so it can be undone. Then **Resume** from that step.
- **Files tab** lists every file read, edited, created, moved, held or blocked. **Export audit log** saves every tool call as a CSV.
- When Jarvis hits a folder without access, the chat shows an **Allow reading …** button instead of guessing.

**From Phase 2**: lanes, streaming chat, plans you approve or edit, autonomy levels, stop and resume, parallel lanes, memory, settings and notifications.

**Not yet**: Excel, PowerPoint and PDF, Word editing, web research, scheduled jobs and voice.

### First run

1. Install Ollama from https://ollama.com/download/mac and open it. It sits in the menu bar.
2. Open JARVIS. The setup card in the chat shows Ollama as running; click **Download qwen3:8b** (about 5 GB). On a Mac with 8 GB of memory, pick `qwen3:4b` in Settings instead.
3. Ask a question, or describe a task and approve the plan.

### Change from the spec

The spec uses the paid Anthropic API through the Claude Agent SDK. This build must stay free, so the agent runs on a local model through Ollama (`electron/ollama.ts`). A local 4 to 8B model is noticeably weaker than Claude at long plans and careful writing.

## Install (no developer tools needed)

1. In this repo on GitHub, open **Releases → JARVIS for Mac** and download `JARVIS-mac.dmg`.
2. Open it and drag **JARVIS** into **Applications**.
3. The app isn't notarised yet (that needs a paid Apple developer account), so macOS blocks the first launch. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.

## Run from source

You need Node.js 22 or newer.

```
cd mac
npm install
npm start          # build and launch
npm run dev        # live-reloading development mode
npm test           # unit tests
npm run e2e        # end-to-end tests against the real Electron app
npm run dist       # build the .dmg into mac/release/
```

## Layout

- `electron/main.ts`: the window (1440×900, minimum 1180×720), security settings and the IPC handlers
- `electron/preload.ts`: the narrow, typed bridge the UI is allowed to use (`shared/types.ts` defines it)
- `electron/agent.ts`: runs lanes: triage, plans, approval, steps, gates, stop and resume, parallel slots
- `electron/prompts.ts`: what the model is told, the plan's JSON format and the gate rules
- `electron/ollama.ts`: the local model client (status, download, streaming chat)
- `electron/workspace.ts`: folder access checks, the file tools, staged changes (apply, undo), checkpoints and restore
- `electron/db.ts`: SQLite storage using Node's built-in driver
- `src/store.ts`: the renderer state, fed by events from the main process
- `src/components/`: the title bar, sidebar, lane column (chat, plan, gates, composer), setup card, settings, workspace tabs and checkpoint bar
- `tests/agent.test.ts`: the agent's behaviour against a scripted model
- `tests/workspace.test.ts`: access rules (including symlink escapes), changes, risk and checkpoints
- `e2e/`: end-to-end tests that drive the real app against a fake Ollama server
- `src/styles/modernist.css`: the Modernist design system tokens and components; Archivo is bundled locally
