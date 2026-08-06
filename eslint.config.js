import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Phase 7 boundary: the runtime must not know the reference simulation
    // exists (domain code depends on @sim/runtime, never the reverse) —
    // and per the Phase 8 boundary it must have zero Express imports.
    files: ["packages/runtime/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "express",
              message: "@sim/runtime must have zero Express imports (Phase 8 boundary).",
            },
          ],
          patterns: [
            {
              group: ["@sim/refsim", "@sim/refsim/*", "**/refsim/**", "**/wator*"],
              message:
                "@sim/runtime must have zero Wa-Tor/refsim imports (Phase 7 extraction boundary).",
            },
          ],
        },
      ],
    },
  },
  {
    // Sim packages never depend on the server layer.
    files: ["packages/refsim/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { paths: [{ name: "express", message: "Sim packages must not depend on the server layer." }] },
      ],
    },
  },
  {
    // The server may use only the public package entry points, never
    // internals (deep imports are also blocked by the packages' exports
    // maps — this makes the intent visible at lint time).
    files: ["apps/server/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@sim/runtime/*", "@sim/refsim/*"],
              message: "Use only the public package entry points (@sim/runtime, @sim/refsim).",
            },
          ],
        },
      ],
    },
  },
);
