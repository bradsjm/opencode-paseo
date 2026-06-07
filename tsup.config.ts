import { defineConfig } from "tsup"

/** tsup build configuration for the opencode-paseo plugin. */
export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  noExternal: ["jsonc-parser"],
})
