import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../skills/role-runtime/SKILL.md", import.meta.url), "utf8");

test("integrated role skill pins desktop list, create, read, send, and wait contracts", () => {
  assert.match(skill, /list_projects\(\{\}\)/);
  assert.match(skill, /list_threads\(\{ limit: 50 \}\)/);
  assert.match(skill, /create_thread\(\{/);
  assert.match(skill, /read_thread\(\{/);
  assert.match(skill, /send_message_to_thread\(\{/);
  assert.match(skill, /wait_threads\(\{/);
  assert.match(skill, /`projectId` belongs only at `create_thread\.target\.projectId`/);
  assert.match(skill, /never add a second top-level `projectId` beside `target`/);
  assert.match(skill, /environment: \{ type: "local" \}/);
  assert.match(skill, /message field is named `prompt`/);
  assert.match(skill, /never `message`, `content`, `taskId`, `projectId`, or `target`/);
  assert.match(skill, /both `pinnedThreads` and `threads`/);
  assert.match(skill, /gpt-5\.6-luna/);
  assert.match(skill, /clientThreadId/);
  assert.match(skill, /do not call `create_thread` again/);
  assert.match(skill, /do not fall back to `fork_thread`/);
});
