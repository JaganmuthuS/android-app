# JARVIS for Mac

A desktop agent for documents, folders and research, built from `CLAUDE_CODE_PROMPT.md` and the `JARVIS Workspace` design.

## Status: Phase 2 of 8

**Works now**
- Lanes and chat are saved on your Mac in a SQLite database (`~/Library/Application Support/JARVIS/jarvis.db`).
- Replies stream in word by word from a **free local AI model** through [Ollama](https://ollama.com). Nothing you type leaves your Mac.
- A question gets a direct answer. A task gets a **plan first**: 3 to 8 steps plus a scope line, and nothing runs until you approve it.
- **Edit steps** before approving: rewrite, reorder, delete, add, or mark a step as gated.
- Steps that send, email, export, delete, publish or overwrite are **gated**. Jarvis stops and asks every time, at every autonomy level.
- Autonomy: under **Autonomous**, plans start without approval, but gates still ask.
- **Stop** pauses a lane; **Resume** carries on from the same step. Lanes interrupted by quitting the app come back paused.
- Several lanes can run, up to the limit you set (1 to 4); extra lanes queue.
- **Memory**: add, switch off or delete memories in Settings. Every lane follows the enabled ones.
- **Settings**: engine status, model choice and download progress, Ollama address, default autonomy, parallel lanes, and "Delete all local data".
- macOS notifications when a lane is waiting for you and JARVIS isn't the front window.

**Not yet**: opening or editing files, folder access, changes review, checkpoints, web research and voice. Phases 3 to 7 add them, and the right-hand tabs say so until then.

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
- `electron/db.ts`: SQLite storage using Node's built-in driver
- `src/store.ts`: the renderer state, fed by events from the main process
- `src/components/`: the title bar, sidebar, lane column (chat, plan, gates, composer), setup card, settings, workspace tabs and checkpoint bar
- `tests/agent.test.ts`: the agent's behaviour against a scripted model
- `e2e/`: end-to-end tests that drive the real app against a fake Ollama server
- `src/styles/modernist.css`: the Modernist design system tokens and components; Archivo is bundled locally
