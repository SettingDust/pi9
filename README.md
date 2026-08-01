# Pi9

Pi9 is a collection of extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Downstream differences from upstream

This branch is synced to upstream's Generation-based Subagent runtime, then keeps a small set of downstream features that upstream does not provide yet. Keep these differences visible during future upstream syncs:

| Area | Downstream behavior | Upstream status |
| --- | --- | --- |
| Package agents | Discovers standard `package.json` `pi.agents` manifests through Pi's package manager. | Upstream discovers user and project agents only. |
| Dynamic Subagent schema | Refreshes `spawn.agent` and `spawn.model` enums from discovered agents and available/scoped models at session start; runtime validation remains authoritative. | Upstream keeps compact string fields and validates at runtime. |
| Pane-owned execution | Runs child generations in mux panes through `packages/subagent/src/pane-execution.ts`, with Herdr placement, steer/cancel controls, retained child session files, activity sidecars, completed-pane reopen, and bounded completed-pane retention. | Upstream executes through generic Generation runtime boundaries without pane ownership. |
| Launcher safety | Uses launcher-owned failure sidecars and atomic prompt argv handling so early script failure is observable and multiline prompts stay one child prompt. | Upstream launcher behavior does not cover these pane transport guarantees. |
| Native child skills | Passes requested skills through child environment/system prompt injection, keeping the delegated task as the only positional prompt. | Upstream does not implement pane-child skill preloading. |
| Upstream hooks | Core changes are limited to generic generation controls, external activity observation, retained session-file resume, and dispose callbacks for retained resources. | Keep pane-specific logic in adapter modules so future upstream merges stay small. |
| Deferred | Do not restore old Run-based pane files or UI affordances directly. | Any future pane UI work should attach through the Generation pane adapter. |

## Packages
- [`@pi9/ask`](./packages/ask) — an interactive tool for asking the user focused questions.
- [`@pi9/context`](./packages/context) — an inline breakdown of current context-window usage.
- [`@pi9/persona`](./packages/persona) — prompt-based agent personas that can be switched per session.
- [`@pi9/subagent`](./packages/subagent) — asynchronous, resumable, and recursive subagents with live progress and tree-wide concurrency limits.
- [`@pi9/todo`](./packages/todo) — phased, session-aware task planning with immutable task names and atomic status transitions.
- [`@pi9/whisper`](./packages/whisper) — local agent-to-agent communication.

## Development

```bash
npm install
npm run check
npm run build
```

Run a command for one package with npm's workspace flag:

```bash
npm test --workspace @pi9/ask
npm test --workspace @pi9/context
npm test --workspace @pi9/persona
npm test --workspace @pi9/subagent
npm test --workspace @pi9/todo
npm test --workspace @pi9/whisper
```