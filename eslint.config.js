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
    // exists. Domain code depends on @sim/runtime, never the reverse.
    files: ["packages/runtime/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
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
);
