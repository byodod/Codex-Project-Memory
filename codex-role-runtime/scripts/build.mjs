import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await build({
  entryPoints: { "mcp-server": "src/mcp-server.ts", hook: "src/hook.ts", cli: "src/cli.ts", library: "src/index.ts" },
  outdir: "dist", outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22",
  sourcemap: false, minify: false, logLevel: "info"
});

for (const name of ["mcp-server.mjs", "hook.mjs", "cli.mjs", "library.mjs"]) {
  const url = new URL(`../dist/${name}`, import.meta.url);
  const source = await readFile(url, "utf8");
  await writeFile(url, source.split("\n").map((line) => line.trimEnd()).join("\n"), "utf8");
}
