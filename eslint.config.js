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
    // The browser renderer: plain ES modules served statically, no build
    // step. Flat config ships no browser globals, so the ones it uses are
    // declared here.
    files: ["apps/server/renderer/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        Element: "readonly",
        localStorage: "readonly",
        getComputedStyle: "readonly",
        requestAnimationFrame: "readonly",
        ResizeObserver: "readonly",
        WebSocket: "readonly",
        atob: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        globalThis: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
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
