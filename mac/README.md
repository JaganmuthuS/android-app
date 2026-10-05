# JARVIS for Mac

A desktop agent for documents, folders and research, built from `CLAUDE_CODE_PROMPT.md` and the `JARVIS Workspace` design.

## Status: Phase 1 of 8

Phase 1 is the full workspace with sample data:
- the title bar with the autonomy control
- task lanes, folder access and memory
- chat with the plan card, step log and approval gate
- the Document, Research and Files tabs
- the Changes rail with Accept, Reject and Undo
- the checkpoint bar with Restore and Resume

Sending the pre-filled request runs the board-report walkthrough. Nothing touches real files yet. The window size and position, the selected lane and tab, and the autonomy level are remembered between launches.

### Change from the spec

The spec uses the paid Anthropic API. This build must stay free, so Phase 2 will run the agent on a local model through [Ollama](https://ollama.com), which runs on Apple silicon at no cost. The agent layer will stay pluggable so an Anthropic API key can be added later.

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

- `electron/main.ts`: the window (1440×900, minimum 1180×720), security settings and saved state
- `electron/preload.ts`: the narrow, typed bridge the UI is allowed to use
- `src/demo.ts`: the walkthrough's state and view logic, written as pure functions and covered by `tests/demo.test.ts`
- `src/mock.ts`: the sample workspace
- `src/components/`: the title bar, sidebar, lane column, workspace tabs and checkpoint bar
- `src/styles/modernist.css`: the Modernist design system tokens and components; Archivo is bundled locally
