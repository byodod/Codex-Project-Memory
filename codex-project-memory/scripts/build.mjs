import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });

await build({
  entryPoints: {
    "mcp-server": "src/mcp-server.ts",
    hook: "src/hook.ts",
    "integrated-hook": "src/integrated-hook.ts",
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

await build({
  entryPoints: {
    "role-mcp-server": "../codex-role-runtime/src/mcp-server.ts",
    "role-hook": "../codex-role-runtime/src/hook.ts",
    "role-cli": "../codex-role-runtime/src/cli.ts",
    "role-library": "../codex-role-runtime/src/index.ts"
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
