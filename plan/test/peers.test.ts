import { test, expect } from "bun:test";
import { readVerify } from "../src/peers.ts";

/**
 * What survived pi-goal's `progress.ts` after the merge.
 *
 * Its other half read `todo:updated` off the bus to count how the task list was tracking;
 * with the list and the objective now in one state, that became a field read and the
 * defensive parsing around it became nothing at all. This half did not collapse, because
 * pi-lens is a genuine peer rather than the other half of the same extension.
 */

test("a verify:passed payload yields the command that passed", () => {
  expect(readVerify({ cmd: "bun test", cwd: "/somewhere" })).toEqual({ cmd: "bun test" });
});

test("a malformed payload yields null rather than throwing", () => {
  // The publisher may not be the sibling that ships today, and a subscriber is handed
  // `data` and nothing else — so the payload is treated as untrusted.
  for (const bad of [undefined, null, {}, { cmd: "" }, { cmd: 5 }, "nonsense", []]) {
    expect(readVerify(bad)).toBeNull();
  }
});

test("the payload's cwd is ignored rather than compared", () => {
  // Both extensions resolve their cwd from the same session, so a verify:passed reaching
  // this handler is by construction about this session's project. Latching a cwd to check
  // it against is the pattern pi-memory removed for good reason.
  expect(readVerify({ cmd: "npm test", cwd: "/a/completely/different/place" })).toEqual({
    cmd: "npm test",
  });
});
