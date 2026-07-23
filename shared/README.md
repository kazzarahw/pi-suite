# pi-shared

Types & constants shared across the [`pi-*` extension suite](https://github.com/kazzarahw?tab=repositories&q=pi-) — the single source of truth for the cross-extension contract, so a mismatch between two extensions is caught by the type-checker rather than at runtime.

Consumed as a **devDependency** (`"pi-shared": "github:kazzarahw/pi-shared"`). It ships types plus a handful of trivial constants and pure helpers — no runtime dependencies, no bundling cost.

## Contents

| Module | Exports | House-style |
|---|---|---|
| `mode.ts` | `Mode`, `MODES`, `DEFAULT_MODE` — the universal `off \| notify \| block` enforcement dial | §7 |
| `events.ts` | `EventPayloads`, `EventName`, `EVENTS`, and shared payload types (`Diagnostic`, `TodoItem`, …) — the `domain:event` vocabulary | §4 |
| `tags.ts` | `TAG_PREFIX`, `tagName`, `injectionHeader`, `injectionBlock` — the `<pi-<name>>` context-injection format | §6 |

The full design contract for the whole suite lives here too, in [`HOUSE-STYLE.md`](./HOUSE-STYLE.md).

## Usage

```ts
import { DEFAULT_MODE, EVENTS, injectionBlock, type Mode } from "pi-shared";
```

AGPL-3.0.
