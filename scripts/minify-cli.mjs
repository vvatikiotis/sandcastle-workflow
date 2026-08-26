import { chmod, readFile, writeFile } from "node:fs/promises";
import { minify } from "terser";

const cliPath = "dist/cli.js";
const source = await readFile(cliPath, "utf8");
const hashbangMatch = source.match(/^#![^\n]*(?:\n|$)/);
const hashbang = hashbangMatch?.[0] ?? "#!/usr/bin/env node\n";
const javascript = source.slice(hashbangMatch?.[0].length ?? 0);

const result = await minify(javascript, {
  module: true,
  ecma: 2022,
  compress: {
    unsafe: false,
    drop_console: false,
  },
  mangle: {
    toplevel: true,
  },
  keep_fnames: true,
  keep_classnames: true,
  format: {
    comments: /@license|@copyright|@preserve|^!/i,
  },
  sourceMap: false,
});

if (result.code === undefined) {
  throw new Error("Terser produced no CLI output");
}

await writeFile(cliPath, `${hashbang}${result.code}\n`);
await chmod(cliPath, 0o755);
