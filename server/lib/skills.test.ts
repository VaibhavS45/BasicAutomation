import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listSkills,
  saveSkill,
  validateSkillName,
  validateSkillTools,
} from "./skills.js";

const GRANTED = new Set(["gmail.search", "gmail.read", "search.web", "notion.searchPages"]);
const WILDCARDS = new Set(["notion.*", "browser.*"]);

async function tmpRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-test-"));
  await fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
  return root;
}

describe("validateSkillName", () => {
  it("accepts lowercase-dash names, rejects the rest", () => {
    expect(() => validateSkillName("weekly-digest")).not.toThrow();
    for (const bad of ["Weekly", "a", "has space", "has_underscore", "../x", "@gmail"]) {
      expect(() => validateSkillName(bad)).toThrow();
    }
  });
});

describe("validateSkillTools", () => {
  it("accepts granted actions and granted worker wildcards, rejects the rest", async () => {
    await expect(
      validateSkillTools(["gmail.search", "notion.*"], GRANTED, WILDCARDS),
    ).resolves.toEqual(["gmail.search", "notion.*"]);
    await expect(validateSkillTools(["gmail.send"], GRANTED, WILDCARDS)).rejects.toThrow(
      /not available/,
    );
    // A wildcard the user was never granted is still rejected.
    await expect(validateSkillTools(["slack.*"], GRANTED, WILDCARDS)).rejects.toThrow(
      /not available/,
    );
    await expect(validateSkillTools([], GRANTED, WILDCARDS)).rejects.toThrow();
  });
});

describe("saveSkill + listSkills", () => {
  it("round-trips a skill and refuses silent overwrites", async () => {
    const root = await tmpRoot();
    const input = {
      name: "triage-inbox",
      description: "Triage the inbox each morning.",
      plan: "1. Search unread. 2. Draft replies.",
      tools: ["gmail.search", "gmail.read"],
    };
    const saved = await saveSkill(input, { root, granted: GRANTED });
    expect(saved.invoke).toBe("/triage-inbox");
    const listed = await listSkills(root);
    expect(listed).toEqual([
      { name: "triage-inbox", description: "Triage the inbox each morning.", userSaved: true },
    ]);
    const raw = await fs.readFile(
      path.join(root, ".agents", "skills", "triage-inbox", "SKILL.md"),
      "utf8",
    );
    expect(raw).toContain("gmail.search");
    await expect(saveSkill(input, { root, granted: GRANTED })).rejects.toThrow(
      /already exists/,
    );
    await expect(
      saveSkill({ ...input, plan: "new" }, { root, granted: GRANTED, }),
    ).rejects.toThrow();
    await saveSkill({ ...input, plan: "new", overwrite: true }, { root, granted: GRANTED });
    expect(await listSkills(root)).toHaveLength(1);
    await fs.rm(root, { recursive: true, force: true });
  });
});
