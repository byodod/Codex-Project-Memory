import { execFileSync, spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { BootstrapResponse, RolePolicy } from "./types.js";

type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

export function resolveCodexBinary(): string {
  if (process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }
  if (process.platform === "win32") {
    try {
      const candidates = execFileSync("where.exe", ["codex.cmd"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (candidates[0]) return candidates[0];
    } catch { /* fall back to PATH resolution */ }
  }
  return "codex";
}

export class AppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private lines: Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(message: Rpc) => void>();
  readonly stderr: string[] = [];

  private constructor(command = resolveCodexBinary()) {
    this.child = spawn(command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      shell: process.platform === "win32" && !command.toLowerCase().endsWith(".exe")
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr.push(chunk); if (this.stderr.length > 50) this.stderr.shift(); });
    this.child.on("exit", (code) => {
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Codex app-server exited with ${code}. ${this.stderr.join("").slice(-2000)}`)); }
      this.pending.clear();
    });
  }

  static async connect(): Promise<AppServerClient> {
    const client = new AppServerClient();
    await client.request("initialize", { clientInfo: { name: "codex-role-runtime", title: "Codex Role Runtime", version: "1.0.0" } });
    client.notify("initialized", {});
    return client;
  }

  private onLine(line: string): void {
    let message: Rpc; try { message = JSON.parse(line) as Rpc; } catch { return; }
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id); if (!waiter) return;
      clearTimeout(waiter.timer); this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`App Server RPC error: ${JSON.stringify(message.error)}`)); else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`App Server timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }

  async startThread(input: { cwd: string; model?: string; policy: RolePolicy; name: string }): Promise<string> {
    const params: Record<string, unknown> = {
      cwd: input.cwd, approvalPolicy: "never", sandbox: input.policy.mode === "read_only" ? "read-only" : "workspace-write",
      serviceName: "codex-role-runtime"
    };
    if (input.model) params.model = input.model;
    const result = await this.request("thread/start", params, 60_000);
    const threadId = result?.thread?.id as string | undefined;
    if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(result)}`);
    await this.request("thread/name/set", { threadId, name: input.name }).catch(() => undefined);
    return threadId;
  }

  async setGoal(threadId: string, objective: string): Promise<void> {
    await this.request("thread/goal/set", { threadId, objective: objective.slice(0, 4000), status: "active" });
  }

  async resumeThread(threadId: string): Promise<void> {
    const result = await this.request("thread/resume", { threadId }, 60_000);
    if (result?.thread?.id !== threadId) throw new Error(`thread/resume returned the wrong thread: ${JSON.stringify(result)}`);
  }

  async bootstrapHealth(threadId: string, expected: BootstrapResponse, contextText: string): Promise<BootstrapResponse> {
    const outputSchema = {
      type: "object", additionalProperties: false,
      properties: {
        role_id: { type: "string" }, mission: { type: "string" }, owned_domains: { type: "array", items: { type: "string" } },
        critical_invariants: { type: "array", items: { type: "string" } }, open_questions: { type: "array", items: { type: "string" } },
        architecture_epoch: { type: "integer" }
      },
      required: ["role_id", "mission", "owned_domains", "critical_invariants", "open_questions", "architecture_epoch"]
    };
    let lastText = "";
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error("Bootstrap health turn timed out.")); }, 180_000);
      const listener = (message: Rpc) => {
        const params = message.params || {};
        if (params.threadId && params.threadId !== threadId) return;
        if (message.method === "item/agentMessage/delta") lastText += params.delta || "";
        if (message.method === "item/completed" && params.item?.type === "agentMessage") lastText = params.item.text || lastText;
        if (message.method === "turn/completed") {
          clearTimeout(timer); this.listeners.delete(listener);
          if (params.turn?.status && !["completed", "Completed"].includes(params.turn.status)) reject(new Error(`Bootstrap turn ${params.turn.status}`));
          else resolve();
        }
      };
      this.listeners.add(listener);
    });
    const prompt = [
      "You are bootstrapping a persistent Codex role generation. Do not use tools and do not perform project work.",
      "Return only the requested JSON, reproducing the authoritative values exactly.", contextText,
      `Expected values: ${JSON.stringify(expected)}`
    ].join("\n\n");
    await this.request("turn/start", { threadId, input: [{ type: "text", text: prompt }], outputSchema }, 60_000);
    await completed;
    try { return JSON.parse(lastText) as BootstrapResponse; }
    catch {
      const match = lastText.match(/\{[\s\S]*\}/); if (!match) throw new Error(`Bootstrap returned no JSON: ${lastText.slice(-2000)}`);
      return JSON.parse(match[0]) as BootstrapResponse;
    }
  }

  async runTurn(threadId: string, prompt: string, timeoutMs = 900_000): Promise<string> {
    await this.resumeThread(threadId);
    let lastText = "";
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error("Role dispatch turn timed out.")); }, timeoutMs);
      const listener = (message: Rpc) => {
        const params = message.params || {};
        if (params.threadId && params.threadId !== threadId) return;
        if (message.method === "item/agentMessage/delta") lastText += params.delta || "";
        if (message.method === "item/completed" && params.item?.type === "agentMessage") lastText = params.item.text || lastText;
        if (message.method === "turn/completed") {
          clearTimeout(timer); this.listeners.delete(listener);
          if (params.turn?.status && !["completed", "Completed"].includes(params.turn.status)) reject(new Error(`Role dispatch turn ${params.turn.status}`));
          else resolve();
        }
      };
      this.listeners.add(listener);
    });
    await this.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] }, 60_000);
    await completed;
    return lastText.trim();
  }

  close(): void { this.lines.close(); this.child.stdin.end(); this.child.kill(); }
}
