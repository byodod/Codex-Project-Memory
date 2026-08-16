import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });

await build({
  entryPoints: {
    "mcp-server": "src/mcp-server.ts",
    hook: "src/hook.ts",
    cli: "src/cli.ts",
    library: "src/index.ts"
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: false,
  logLevel: "info"
});
