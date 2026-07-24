/**
 * Loads every extension from the CURRENT working directory and asserts each one
 * registers the tools `SURFACE` declares. Run by `scripts/smoke-install.sh` inside a
 * clean `--omit=dev` clone, so an import that depends on a devDependency fails here.
 *
 * Deliberately does not require a `pi` binary: the failure being guarded is module
 * resolution with devDependencies absent, which import + registration exercises directly.
 */
import { SURFACE } from "../shared/surface.ts";
import { createFakeApi } from "../shared/test/harness.ts";

const failures: string[] = [];

for (const ext of SURFACE) {
  try {
    const api = createFakeApi();
    const mod = (await import(`../${ext.dir}/index.ts`)) as { default: (pi: unknown) => void };
    if (typeof mod.default !== "function") {
      failures.push(`${ext.dir}: default export is not a factory function`);
      continue;
    }
    mod.default(api);

    const tools = [...api.tools.keys()].sort();
    const expected = [...ext.tools].sort();
    if (JSON.stringify(tools) !== JSON.stringify(expected)) {
      failures.push(`${ext.dir}: registered [${tools}], expected [${expected}]`);
    }
    if (!api.commands.has(ext.command)) {
      failures.push(`${ext.dir}: did not register /${ext.command}`);
    }
    console.log(`  ok  ${ext.dir.padEnd(8)} tools=[${tools}] command=/${ext.command}`);
  } catch (error) {
    failures.push(`${ext.dir}: threw during load — ${(error as Error).message}`);
    console.log(`  FAIL ${ext.dir}: ${(error as Error).message}`);
  }
}

if (failures.length > 0) {
  console.error(`\nsmoke load FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`\nall ${SURFACE.length} extensions loaded and registered correctly`);
