import { createHash, randomUUID } from "node:crypto";

export function nowIso(): string { return new Date().toISOString(); }
export function newId(prefix: string): string { return `${prefix}_${randomUUID()}`; }
export function stableId(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function compactText(value: unknown, max: number): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}
export function uniqueStrings(values: readonly string[] | undefined, max = 100): string[] {
  return [...new Set((values ?? []).map((value) => compactText(value, 1000)).filter(Boolean))].slice(0, max);
}
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
export function slug(value: string): string {
  const result = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result || result.length > 64) throw new Error("Role key must normalize to 1-64 ASCII characters.");
  return result;
}
export function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try { return new RegExp(pattern, "i").test(value); } catch { return value === pattern; }
  });
}
export function redact(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  return JSON.parse(text.replace(/(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/gi, "[REDACTED]"));
}
