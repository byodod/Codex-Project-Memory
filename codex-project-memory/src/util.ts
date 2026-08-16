import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

export function compactText(value: unknown, max = 20_000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const normalized = text.replace(/\r\n/g, "\n").replace(/[\t ]+\n/g, "\n").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}\n…[truncated]`;
}

const SECRET_KEY = /(?:secret|token|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
  /((?:secret|token|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi
];

function redactString(value: string): string {
  return SECRET_VALUE.reduce((text, pattern) => text.replace(pattern, "$1[REDACTED]"), value);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactString(compactText(value, 12_000));
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function uniqueStrings(values: unknown, maxItems = 50): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => compactText(v, 1000)).filter(Boolean))].slice(0, maxItems);
}

export function ftsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_./\\:-]+/gu) ?? [];
  return [...new Set(tokens)]
    .slice(0, 20)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

export function atomicWriteSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

export function markdownEscape(value: string): string {
  return value.replace(/[<>]/g, (char) => (char === "<" ? "&lt;" : "&gt;"));
}
