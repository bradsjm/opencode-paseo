import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  noExternal: ["jsonc-parser"],
})
