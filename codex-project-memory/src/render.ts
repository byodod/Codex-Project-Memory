import { MainlineCapsule, MemoryRecord, ProjectContext, TaskRecord } from "./types.js";
import { compactText } from "./util.js";

const bullets = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- NONE";

function stateList(value: string[] | "NONE" | "UNKNOWN", limit = 12): string[] {
  if (typeof value === "string") return [value];
  return value.slice(0, limit);
}

function appendSection(lines: string[], heading: string, values: string[], maxChars: number): void {
  const candidate = ["", `## ${heading}`, ...values.map((value) => `- ${compactText(value, 1000)}`)];
  for (const line of candidate) {
    if ([...lines, line].join("\n").length > maxChars) {
      const marker = "- …[capsule budget reached; use mainline_get for full state]";
      if ([...lines, marker].join("\n").length <= maxChars) lines.push(marker);
      return;
    }
    lines.push(line);
  }
}

export function renderMainlineCapsule(capsule: MainlineCapsule, maxChars = 6500): string {
  const work = capsule.active_work_item;
  const plan = capsule.active_plan;
  const verification = capsule.latest_valid_verification;
  const lines = [
    "# Project Memory Mainline Capsule",
    "Historical working state only. Current user instructions and repository authority take precedence.",
    `Recovery: ${capsule.recovery_mode}${capsule.degraded_reason ? ` (${capsule.degraded_reason})` : ""}`,
    `Project: ${compactText(capsule.project.name, 200)} (${capsule.project.id})`,
    `Project goal: ${compactText(capsule.project_goal, 1000)}`,
    `Plan: ${plan === "UNKNOWN" ? "UNKNOWN" : `${plan.id} revision=${plan.revision} status=${plan.status}`}`,
    `Milestone: ${compactText(capsule.current_milestone, 500)}`,
    `Work item: ${work === "UNKNOWN" ? "UNKNOWN" : `${compactText(work.title, 300)} (${work.id}; version=${work.version}; plan_revision=${work.plan_revision ?? "UNKNOWN"})`}`,
    `Exact next action: ${compactText(capsule.exact_next_action, 700)}`,
    `Verification: ${verification.freshness}/${verification.status} — ${compactText(verification.command_or_criterion, 500)}`,
    `Repository: branch=${capsule.repository.branch}; revision=${capsule.repository.revision}; state=${capsule.repository.state}; workspace=${capsule.repository.workspace_digest}`,
    `Checkpoint: ${capsule.checkpoint === "NONE" ? "NONE" : `${capsule.checkpoint.id} at ${capsule.checkpoint.created_at}`}`
  ];

  if (work !== "UNKNOWN") {
    const criteria = work.acceptance_criteria.map((item) => `${work.completed_items.includes(item) ? "[x]" : "[ ]"} ${item}`);
    appendSection(lines, "Acceptance criteria", criteria.length ? criteria : ["NONE"], maxChars);
  }
  appendSection(lines, "Blockers", stateList(capsule.blockers), maxChars);
  appendSection(lines, "Definition of done", stateList(capsule.definition_of_done), maxChars);
  appendSection(lines, "Critical constraints", stateList(capsule.critical_constraints), maxChars);
  appendSection(lines, "Open user decisions", stateList(capsule.open_user_decisions), maxChars);
  appendSection(lines, "Latest verification evidence", [
    `freshness=${verification.freshness}; status=${verification.status}; at=${verification.created_at ?? "UNKNOWN"}`,
    verification.evidence
  ], maxChars);
  appendSection(lines, "Do not repeat", [capsule.recent_failed_approach], maxChars);
  return lines.join("\n").slice(0, maxChars);
}

export function renderMemories(memories: MemoryRecord[], heading = "Relevant project memory", maxChars = 4000): string {
  if (!memories.length) return "";
  const lines = [
    `## ${heading}`,
    "Provenance-labelled historical context only; current instructions and observed workspace state take precedence."
  ];
  for (const memory of memories) {
    const scope = [memory.file_path, memory.symbol, memory.error_signature].filter(Boolean).join(" · ");
    const line = `- [${memory.kind}; authority=${memory.authority}; id=${memory.id}] ${memory.summary}: ${memory.content}${scope ? ` (scope: ${scope})` : ""}`;
    if ([...lines, line].join("\n\n").length > maxChars) break;
    lines.push(line);
  }
  return lines.join("\n\n");
}

export function renderTask(task: TaskRecord, project: ProjectContext, verificationLines: string[] = []): string {
  return [
    "# Project Memory task snapshot",
    "",
    "Historical working state only. Current user instructions and repository authority take precedence.",
    "",
    `Project: ${project.name}`,
    `Branch: ${project.branch ?? "UNKNOWN"}`,
    `Revision at restore: ${project.revision ?? "UNKNOWN"}`,
    `Task: ${task.title} (${task.id}; version=${task.version})`,
    `Goal: ${task.goal}`,
    `Milestone: ${task.milestone ?? "UNKNOWN"}`,
    `Exact next action: ${task.exact_next_action ?? task.next_steps[0] ?? "UNKNOWN"}`,
    "",
    "## Acceptance criteria",
    bullets(task.acceptance_criteria.map((item) => `${task.completed_items.includes(item) ? "[x]" : "[ ]"} ${item}`)),
    "",
    "## Next steps",
    bullets(task.next_steps),
    "",
    "## Blockers",
    bullets(task.blockers),
    ...(task.notes ? ["", "## Notes", task.notes] : []),
    ...(verificationLines.length ? ["", "## Recent verification", ...verificationLines.map((line) => `- ${line}`)] : [])
  ].join("\n");
}
