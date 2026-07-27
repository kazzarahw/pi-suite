/**
 * One tool-call row, in Pi's own grammar.
 *
 * Pi renders a *built-in* tool call as a bold name in `toolTitle` followed by the thing
 * it acts on — `read src/foo.ts`, `grep /pattern/ in src`, `ls .`. A custom tool that
 * defines no `renderCall` falls back to `Text(theme.fg("toolTitle", theme.bold(name)))`:
 * the name alone, with no argument at all.
 *
 * That fallback is why this suite read as bolted on. Every extension but pi-browser took
 * it, so a transcript alternated between Pi's rows (which say what they are doing) and
 * the suite's (which say only `memory_write`), and the one extension that *did* override
 * it rendered the whole line `muted` with a left pad of 1 — visibly not the same kind of
 * object as the row above it.
 *
 * So: one formatter, matching what `core/tools/read.js` and friends actually emit.
 *
 * - name in `toolTitle` + bold, exactly as the fallback does, so a tool that has nothing
 *   to add still looks like the same family;
 * - the primary argument in `accent`, which is where Pi puts a path or a pattern;
 * - `Text` at padding `(0, 0)` — the row's `Box` supplies padding, and `Text` word-wraps
 *   to the width it is given rather than overflowing it.
 *
 * Kept out of `shared/index.ts` deliberately, alongside `settings-panel.ts`: it pulls
 * `pi-tui`, and re-exporting it from the barrel would drag that into every importer.
 * Import this module directly.
 */
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Render one tool-call row.
 *
 * @param name    the tool's registered name — the bold half
 * @param detail  the interesting half (`search "pi extensions"`, `recall auth-flow`),
 *                or `""` for a tool whose name says everything
 * @param theme   the theme handed to `renderCall`
 * @param reuse   `context.lastComponent`, reused in place the way Pi's built-ins do
 */
export function renderToolCall(name: string, detail: string, theme: Theme, reuse?: unknown): Text {
  const text = reuse instanceof Text ? reuse : new Text("", 0, 0);
  const title = theme.fg("toolTitle", theme.bold(name));
  text.setText(detail ? `${title} ${theme.fg("accent", detail)}` : title);
  return text;
}
