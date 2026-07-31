import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
});
