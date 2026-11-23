import { beforeAll, describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const origins = ["ai", "actions", "security", "testkit", "contracts"]
  .map((name) => `packages/${name}/src`)
  .concat("apps/reference-host/src");
let eslint: ESLint;
beforeAll(() => { eslint = new ESLint(); });

async function restrictions(dir: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: `${dir}/loader-probe.ts` });
  expect(results.flatMap((result) => result.messages).filter((message) => message.fatal)).toEqual([]);
  return results.flatMap((result) => result.messages)
    .filter((message) => ["no-restricted-imports", "no-restricted-syntax", "no-restricted-globals"]
      .includes(message.ruleId ?? ""))
    .map((message) => message.ruleId!);
}

describe.each(origins)("module-loading boundary in %s", (dir) => {
  it.each([
    "import { createRequire as loader } from 'node:module'; export const load = loader(import.meta.url);",
    "import * as mod from 'node:module'; export const load = mod.createRequire(import.meta.url);",
    "import { createRequire } from 'module'; export const load = createRequire(import.meta.url);",
    "export const value = import('node:module');",
    "export { createRequire } from 'node:module';",
    "export * from 'module';",
    "export const value = process.getBuiltinModule('module');",
    "export const value = process['getBuiltinModule']('module');",
    "const { getBuiltinModule: load } = process; export const value = load('module');",
    "const load = require; export const value = load('@dap/contracts/mint');",
    "export const value = module.require('@dap/contracts/mint');",
    "export const value = process.mainModule.require('@dap/contracts/mint');",
  ])("rejects alternate loaders: %s", async (code) => {
    expect(await restrictions(dir, code)).not.toEqual([]);
  });

  it.each([
    "const name = 'x'; export const value = import(name);",
    "export const value = new Function('return 1');",
  ])("retains BASE syntax restrictions: %s", async (code) => {
    expect(await restrictions(dir, code)).toContain("no-restricted-syntax");
  });

  it.each([
    "import * as value from '@dap/contracts'; export { value };",
    "export const value = import('@dap/contracts');",
    "import { randomUUID } from 'node:crypto'; export const value = randomUUID;",
  ])("allows ordinary explicit imports: %s", async (code) => {
    expect(await restrictions(dir, code)).toEqual([]);
  });
});

it.each(["packages/security/src", "packages/testkit/src"])("allows mint imports in %s", async (dir) => {
  for (const code of [
    "import * as value from '@dap/contracts/mint'; export { value };",
    "export const value = import('@dap/contracts/mint');",
  ]) expect(await restrictions(dir, code)).toEqual([]);
});
