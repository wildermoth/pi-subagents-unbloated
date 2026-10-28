import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["bench/poc/**"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "bench/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      complexity: ["warn", 15],
      // Swallowing errors with () => {} is deliberate in cleanup paths.
      "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
    },
  },
  {
    // Tests and benchmarks poke at fakes and untyped JSON on purpose.
    files: ["test/**/*.ts", "bench/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/await-thenable": "off", // awaiting a sync value to flush microtasks is deliberate
      "@typescript-eslint/no-require-imports": "off",
      "no-fallthrough": "off", // fake-pi dispatches on event type with shared tails
      complexity: "off",
    },
  },
);
