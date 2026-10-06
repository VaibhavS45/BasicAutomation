import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMemory, deleteMemory, listMemory, readMemory, writeMemory } from "./memory.js";

let tmp: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  prevDataDir = process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"));
  process.env.DATA_DIR = tmp; // guard:allow-env-credential — test isolation
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  else process.env.DATA_DIR = prevDataDir; // guard:allow-env-credential — test isolation
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("memory", () => {
  it("writes, reads, lists, appends, and deletes", async () => {
    expect(await listMemory()).toEqual([]);
    await writeMemory("user", "# me\nLikes concise answers.");
    expect(await readMemory("user")).toContain("concise");
    await appendMemory("user", "Team calls it the dispatch layer.");
    const after = await readMemory("user");
    expect(after).toContain("dispatch layer");
    expect(await listMemory()).toHaveLength(1);
    await deleteMemory("user");
    await expect(readMemory("user")).rejects.toThrow(/No memory/);
  });

  it("scrubs secrets on every write, never persists the value", async () => {
    await writeMemory("user", 'api_key="sk-ant-12345678901234567890"');
    const raw = await readMemory("user");
    expect(raw).not.toContain("sk-ant-12345678901234567890");
    expect(raw).toContain("redacted");
    await appendMemory("user", "api_token=abcdefghijklmnop");
    expect(await readMemory("user")).not.toContain("abcdefghijklmnop");
  });

  it("rejects bad names and empty appends", async () => {
    await expect(writeMemory("../evil", "x")).rejects.toThrow(/Invalid memory name/);
    await expect(appendMemory("user", "   ")).rejects.toThrow(/empty/);
  });
});
