// Security-boundary lint rules (T008).
//  - no eval / new Function / dynamic import() with a NON-literal specifier, anywhere
//  - `@dap/contracts/mint` (the trusted minting runtime) is importable only from
//    packages/security/** and packages/testkit/** — for STATIC, DYNAMIC (literal) imports,
//    and require() calls alike. no-restricted-imports does NOT inspect ImportExpression, so the
//    dynamic forms are enforced here with no-restricted-syntax (ATK-ARCH-05/06).
//  - deep imports INTO the contracts package (relative src/dist paths and undeclared subpaths)
//    are forbidden outside packages/contracts, so registerGrant/grantRecord-style internals
//    stay behind the mint boundary (ATK-ARCH-05).
import tseslint from "typescript-eslint";

const MINT_MSG =
  "The minting runtime is restricted to packages/security and packages/testkit (ATK-ARCH-05).";
const DEEP_MSG =
  "Deep imports into @dap/contracts are forbidden outside packages/contracts. Import the package root @dap/contracts (or the declared @dap/contracts/mint subpath where allowed).";

// ---- no-restricted-imports (STATIC import specifiers) ----

// The deep-import pattern group (ATK-ARCH-05). The `!` negations keep the DECLARED root
// (@dap/contracts) and the restricted mint subpath (@dap/contracts/mint) out of THIS rule; the
// mint subpath is handled separately by the mint restriction.
const DEEP_GROUP = {
  group: [
    "**/contracts/src/**",
    "**/contracts/dist/**",
    "@dap/contracts/*",
    "!@dap/contracts/mint",
    "!@dap/contracts/mint/*",
  ],
  message: DEEP_MSG,
};

// Full restriction (mint + deep) applied to every file by default.
const MINT_AND_DEEP = {
  paths: [{ name: "@dap/contracts/mint", message: MINT_MSG }],
  patterns: [
    {
      group: ["@dap/contracts/mint/*", "**/contracts/src/mint/*", "**/contracts/dist/mint/*"],
      message: MINT_MSG,
    },
    DEEP_GROUP,
  ],
};

// Deep-only restriction: trusted minters may import the mint subpath but never deep internals.
const DEEP_ONLY = { patterns: [DEEP_GROUP] };

// ---- no-restricted-syntax (DYNAMIC import() and require()) ----
// no-restricted-imports does not inspect ImportExpression / CallExpression, so literal dynamic
// imports and require() calls with the same restricted targets are banned here. Per-file
// overrides REPLACE the whole selector list, so every block below is built from these shared
// constants. The regexes match the same specifiers as no-restricted-imports:
//   mint  -> specifier starts with "@dap/contracts/mint"
//   deep  -> specifier contains "contracts/src/" or "contracts/dist/"
const SEL_NONLIT = {
  selector: "ImportExpression[source.type!='Literal']",
  message: "Dynamic import() with a non-literal specifier is forbidden (ATK-ARCH-06).",
};
const SEL_NEWFUNC = {
  selector: "NewExpression[callee.name='Function']",
  message: "`new Function` is forbidden (ATK-ARCH-06).",
};
const SEL_DYN_MINT = {
  selector: "ImportExpression[source.value=/^@dap\\/contracts\\/mint/]",
  message: `${MINT_MSG} (dynamic import / literal)`,
};
const SEL_DYN_DEEP = {
  selector: "ImportExpression[source.value=/contracts\\/(src|dist)\\//]",
  message: `${DEEP_MSG} (dynamic import / literal)`,
};
const SEL_REQ_MINT = {
  selector: "CallExpression[callee.name='require'][arguments.0.value=/^@dap\\/contracts\\/mint/]",
  message: `${MINT_MSG} (require)`,
};
const SEL_REQ_DEEP = {
  selector: "CallExpression[callee.name='require'][arguments.0.value=/contracts\\/(src|dist)\\//]",
  message: `${DEEP_MSG} (require)`,
};

// BASE: banned in EVERY file (dynamic non-literal import + new Function).
const SYNTAX_BASE = [SEL_NONLIT, SEL_NEWFUNC];
// Outside the mint-allowed packages: also ban literal dynamic import / require of mint AND deep.
const SYNTAX_OUTSIDE = [...SYNTAX_BASE, SEL_DYN_MINT, SEL_DYN_DEEP, SEL_REQ_MINT, SEL_REQ_DEEP];
// Trusted minters (security/testkit): ban deep (dynamic + require) but NOT mint — they may reach
// @dap/contracts/mint but nothing deeper.
const SYNTAX_MINTER = [...SYNTAX_BASE, SEL_DYN_DEEP, SEL_REQ_DEEP];

// Aliased createRequire calls are invisible to static dependency extraction. Runtime
// packages use explicit ESM imports; tooling outside packages/apps can still load CJS.
const LOADER_MSG = "Alternate module loaders are forbidden in runtime packages; use explicit ESM imports.";
const MODULE_LOADERS = [
  {
    selector: ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]
      .map((kind) => `${kind}[source.value=/^(node:)?module$/]`).join(", "),
    message: LOADER_MSG,
  },
  {
    selector: [
      "MemberExpression[property.name=/^(getBuiltinModule|mainModule)$/]",
      "MemberExpression[computed=true][property.value=/^(getBuiltinModule|mainModule)$/]",
      "Property[key.name=/^(getBuiltinModule|mainModule)$/]",
      "Property[key.value=/^(getBuiltinModule|mainModule)$/]",
    ].join(", "),
    message: LOADER_MSG,
  },
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", ".specify/**", ".claude/**", ".agents/**", "specs/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": ["error", ...SYNTAX_OUTSIDE],
      "no-restricted-imports": ["error", MINT_AND_DEEP],
      // Not in typescript-eslint's presets, and its defaults skip strings, templates, regexes and comments, which is
      // exactly where an invisible character hides. (tests/architecture/source-hygiene.test.ts also covers bidi controls.)
      "no-irregular-whitespace": ["error", { skipStrings: false, skipComments: false, skipRegExps: false, skipTemplates: false }],
    },
  },
  {
    files: ["packages/**", "apps/**"],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_OUTSIDE, ...MODULE_LOADERS],
      "no-restricted-globals": ["error",
        { name: "require", message: LOADER_MSG },
        { name: "module", message: LOADER_MSG },
      ],
    },
  },
  {
    // packages/contracts may import its own modules (and the mint tree) freely by relative path.
    files: ["packages/contracts/**"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": ["error", ...SYNTAX_BASE, ...MODULE_LOADERS],
    },
  },
  {
    // Trusted minters: the security package and the testkit may import the restricted
    // @dap/contracts/mint subpath (static or dynamic ESM) but NOT deep imports.
    files: ["packages/security/**", "packages/testkit/**"],
    rules: {
      "no-restricted-imports": ["error", DEEP_ONLY],
      "no-restricted-syntax": ["error", ...SYNTAX_MINTER, ...MODULE_LOADERS],
    },
  },
);
