import { execFileSync, spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { RolePolicy } from "./types.js";

type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

export function isMissingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found|no codex thread found|thread(?: id)?[^\n]*not found|unknown thread/i.test(message);
}

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
      const error = new Error(`Codex app-server exited with ${code}. ${this.stderr.join("").slice(-2000)}`);
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      this.pending.clear();
      for (const listener of [...this.listeners]) listener({ method: "app-server/exited", params: { error: error.message } });
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

  async resumeThread(threadId: string): Promise<void> {
    const result = await this.request("thread/resume", { threadId }, 60_000);
    if (result?.thread?.id !== threadId) throw new Error(`thread/resume returned the wrong thread: ${JSON.stringify(result)}`);
  }

  async threadExists(threadId: string): Promise<boolean> {
    try {
      // Existence checks must not resume/load the thread: resume acquires the
      // App Server writer and can race the separate connection that runs work.
      const result = await this.request("thread/read", { threadId, includeTurns: false }, 60_000);
      return result?.thread?.id === threadId;
    } catch (error) {
      if (isMissingThreadError(error)) return false;
      throw error;
    }
  }

  async runTurn(threadId: string, prompt: string, timeoutMs = 900_000): Promise<string> {
    await this.resumeThread(threadId);
    let lastText = "";
    let cleanup = () => undefined;
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("Role dispatch turn timed out.")); }, timeoutMs);
      const listener = (message: Rpc) => {
        const params = message.params || {};
        if (params.threadId && params.threadId !== threadId) return;
        if (message.method === "app-server/exited") {
          cleanup();
          reject(new Error(params.error || "Codex app-server exited during role dispatch."));
          return;
        }
        if (message.method === "item/agentMessage/delta") lastText += params.delta || "";
        if (message.method === "item/completed" && params.item?.type === "agentMessage") lastText = params.item.text || lastText;
        if (message.method === "turn/completed") {
          cleanup();
          if (params.turn?.status && !["completed", "Completed"].includes(params.turn.status)) {
            reject(new Error(`Role dispatch turn ${params.turn.status}${params.turn?.error?.message ? `: ${params.turn.error.message}` : ""}`));
          }
          else resolve();
        }
      };
      cleanup = () => { clearTimeout(timer); this.listeners.delete(listener); };
      this.listeners.add(listener);
    });
    try {
      await this.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] }, 60_000);
      await completed;
      return lastText.trim();
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  close(): void {
    this.lines.close();
    if (this.child.exitCode !== null || this.child.killed) return;

    // Closing stdin lets App Server release loaded-thread writer ownership.
    // On Windows the spawned process may be a cmd.exe wrapper around codex.cmd;
    // killing only that wrapper can orphan the real App Server and leave a
    // permanent `active writer` lock, so force-kill the exact tree only after
    // a short graceful-shutdown window.
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.exitCode !== null) return;
      if (process.platform === "win32" && this.child.pid) {
        const killer = spawn("taskkill.exe", ["/pid", String(this.child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        killer.unref();
      } else {
        this.child.kill();
      }
    }, 2_000);
    timer.unref();
    this.child.once("exit", () => clearTimeout(timer));
  }
}
