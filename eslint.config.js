import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Downgrade to warn — pre-existing patterns that need separate refactor
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  {
    rules: {
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Allow explicit any in justified places (connector adapters, dynamic imports)
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow non-null assertions but flag them
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Allow empty catch blocks (common in best-effort cleanup)
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Allow require() for dynamic imports
      "@typescript-eslint/no-require-imports": "off",
      // @ts-ignore used for optional deps with no types
      "@typescript-eslint/ban-ts-comment": ["warn", { "ts-ignore": "allow-with-description" }],
      // Control chars in regex used for ANSI stripping
      "no-control-regex": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", ".flaio/"],
  },
);
