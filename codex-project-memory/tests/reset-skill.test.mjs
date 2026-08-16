import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("reset-project skill is slash-menu discoverable and explicit-only", async () => {
  const skill = await readFile("skills/reset-project/SKILL.md", "utf8");
  const ui = await readFile("skills/reset-project/agents/openai.yaml", "utf8");

  assert.match(skill, /^---\r?\nname: reset-project\r?\n/m);
  assert.doesNotMatch(skill, /\[TODO:/);
  assert.match(skill, /reset-project --cwd \$projectRoot --confirm-root \$projectRoot/);
  assert.match(skill, /do not call Project Memory or Role Runtime tools/i);
  assert.match(ui, /display_name: "Reset Project Runtime"/);
  assert.match(ui, /default_prompt: "Use \$reset-project /);
  assert.match(ui, /allow_implicit_invocation: false/);
});
