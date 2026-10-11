import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installBudgetAdapters, rollbackBudgetAdapters } from "../src/setup/agents";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("budget adapter setup", () => {
  it("backs up Claude settings, preserves unrelated hooks, and writes the stable budget command", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-setup-"));
    roots.push(root);
    const claude = join(root, ".claude");
    mkdirSync(claude, { recursive: true });
    const before = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] }] },
    };
    writeFileSync(join(claude, "settings.json"), JSON.stringify(before));
    const output: string[] = [];
    expect(installBudgetAdapters({ HOME: root }, { apply: true }, { write: (text) => output.push(text) })).toBe(0);
    const after = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
    expect(after.hooks.PreToolUse).toEqual(expect.arrayContaining(before.hooks.PreToolUse));
    expect(JSON.stringify(after)).toContain("hook budget");
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(existsSync(join(claude, "settings.json.token-furnace-budget-backup"))).toBe(true);
    const openCodePlugin = readFileSync(join(root, ".config", "opencode", "plugins", "token-furnace-budget.ts"), "utf8");
    expect(openCodePlugin).toMatch(/stdin: new Blob|hasUsage/);
    expect(openCodePlugin).toMatch(/event\.type === "session\.idle"/);
    expect(openCodePlugin).toMatch(/client\.session\.messages/);
    expect(openCodePlugin).toMatch(/latest\?\.info\?\.tokens/);
    expect(openCodePlugin).toMatch(/requestId: input\.callID/);
    expect(openCodePlugin).not.toMatch(/TOKEN_FURNACE_QUALIFY_REQUEST_ID \?\? input\.callID/);
    expect(openCodePlugin).not.toMatch(/executable: process\.execPath/);
    expect(openCodePlugin).toMatch(/scheme: "basic"/);
    expect(openCodePlugin).toMatch(/OPENCODE_SERVER_PASSWORD/);
    expect(JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
    expect(rollbackBudgetAdapters({ HOME: root }, { write: () => undefined })).toBe(0);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(JSON.stringify(before));
    expect(existsSync(join(root, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(root, ".config", "opencode", "plugins", "token-furnace-budget.ts"))).toBe(false);
    expect(output.join("")).toMatch(/Claude|Partial/);
  });

  it("leaves malformed native config untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-setup-invalid-"));
    roots.push(root);
    const claude = join(root, ".claude");
    mkdirSync(claude, { recursive: true });
    const path = join(claude, "settings.json");
    writeFileSync(path, "{not-json");
    expect(installBudgetAdapters({ HOME: root }, { apply: true }, { write: () => undefined })).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("{not-json");
  });

  it("leaves a non-array Claude PreToolUse hook list untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-budget-setup-hooks-"));
    roots.push(root);
    const claude = join(root, ".claude");
    mkdirSync(claude, { recursive: true });
    const path = join(claude, "settings.json");
    const before = JSON.stringify({ hooks: { PreToolUse: { keep: true } } });
    writeFileSync(path, before);
    expect(installBudgetAdapters({ HOME: root }, { apply: true }, { write: () => undefined })).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
