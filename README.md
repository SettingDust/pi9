# Pi9

Pi9 is a collection of extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Packages

- [`@pi9/ask`](./packages/ask) — an interactive tool for asking the user focused questions.
- [`@pi9/context`](./packages/context) — an inline breakdown of current context-window usage.
- [`@pi9/persona`](./packages/persona) — prompt-based agent personas that can be switched per session.
- [`@pi9/subagent`](./packages/subagent) — asynchronous, resumable, and recursive subagents with live progress and tree-wide concurrency limits.
- [`@pi9/todo`](./packages/todo) — phased, session-aware task planning with immutable task names and atomic status transitions.
- [`@pi9/whisper`](./packages/whisper) — local agent-to-agent communication.

## Downstream Subagent Differences

This branch uses the upstream Generation-based Subagent runtime as the baseline. Downstream changes are kept as narrow adapters so future upstream syncs can preserve upstream files by default.

- Package agents: discover standard `pi.agents` manifests through Pi's package manager.
- Dynamic schema: refresh `spawn.agent` and `spawn.model` enums from discovered agents and available/scoped models; runtime validation remains authoritative.
- Pane execution: run child generations in mux panes through `pane-execution.ts`, with launcher-owned failure sidecars, atomic prompt argv handling, native child skill loading, activity sidecars, steer/cancel controls, resume via retained child session files, and bounded completed-pane retention.
- Upstream hooks: core changes are limited to generic generation controls, external activity observation, retained session-file resume, and dispose callbacks for retained resources.
- Deferred: do not restore old Run-based pane files or UI affordances directly; any completed-pane reopen UI should attach through the pane adapter without reintroducing Run architecture.

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