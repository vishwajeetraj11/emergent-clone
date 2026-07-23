import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Full jsx-a11y rule set, so the accessibility work in src/components
  // can't silently rot. eslint-config-next already enables a handful of
  // these; its "recommended" preset is the superset and catches the classes
  // of bug that were actually present here — a role="button" div with no key
  // handler, a control nested inside another control, an unlabeled form
  // field. No new dependency: eslint-plugin-jsx-a11y ships as a dependency
  // of eslint-config-next.
  //
  // Only the RULES are spread in, not the preset object: eslint-config-next
  // already registers the `jsx-a11y` plugin, and flat config rejects a second
  // definition of the same plugin name ("Cannot redefine plugin").
  { rules: jsxA11y.flatConfigs.recommended.rules },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
