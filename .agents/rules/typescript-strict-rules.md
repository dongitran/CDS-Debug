---
description: TypeScript strict coding rules for CDS Debug — no any, no ts-ignore, explicit types, VS Code API patterns
---
# TypeScript Strict Rules

> [!IMPORTANT]
> CDS Debug uses TypeScript strict mode with `strictTypeChecked` + `stylisticTypeChecked` ESLint configs. These rules go beyond what `tsc --strict` enforces — they govern how AI-generated code must handle types to prevent runtime crashes and hidden bugs.

## 1. No `any` — Use `unknown` with Type Guards

- **NEVER** use `any` as a type annotation or via implicit inference. ESLint `@typescript-eslint/no-explicit-any` is set to `error`.
- When a value's type is genuinely unknown (parsed JSON, external API response, `try/catch` error), type it as `unknown` and narrow with `typeof`, `instanceof`, or a type guard before use.
- Acceptable: `const err: unknown = e; if (err instanceof Error) logger.error(err.message)`
- Forbidden: `const data: any = await res.json()`

## 2. No `@ts-ignore` / `@ts-nocheck`

- **NEVER** use `@ts-ignore`, `@ts-nocheck`, or `@ts-expect-error` to silence TypeScript errors.
- If a type error appears, **fix the root cause** — correct the type definition, add a type guard, or use proper generics.
- The only exception: `@ts-expect-error // reason: <specific explanation>` in test files to assert a bad type intentionally fails.

## 3. No Non-Null Assertion Operator `!`

- **NEVER** use `value!` to assert non-null/undefined. ESLint `@typescript-eslint/no-non-null-assertion` is set to `error`.
- Use optional chaining (`?.`) for safe access and nullish coalescing (`??`) for fallbacks.
- Forbidden: `const name = user!.name`
- Correct: `const name = user?.name ?? 'Anonymous'`

## 4. No TypeScript Enums — Use `as const`

- **NEVER** use TypeScript `enum` declarations. They compile to runtime objects with reverse-mapping, causing unexpected bundle behavior with esbuild.
- Instead, use `as const` objects with a derived union type:
  ```typescript
  const APP_STATE = { STARTED: 'STARTED', STOPPED: 'STOPPED' } as const;
  type AppState = typeof APP_STATE[keyof typeof APP_STATE];
  ```

## 5. Explicit Return Types on Exported and Async Functions

- **ALWAYS** annotate return types explicitly on exported functions and all async functions. ESLint `@typescript-eslint/explicit-function-return-type` is set to `error` for `src/**`.
- Inferred return types on async functions silently become `Promise<any>` when internal calls are untyped.
- Correct: `async function fetchApps(orgId: string): Promise<CfApp[]>`
- Forbidden: `async function fetchApps(orgId: string) { ... }` (inferred return)

## 6. Consistent Type Imports

- **ALWAYS** use type-only imports when importing types. ESLint `@typescript-eslint/consistent-type-imports` is set to `error`.
- Correct: `import type { CfApp } from '../types';`
- Forbidden: `import { CfApp } from '../types';` (when `CfApp` is only used as a type)
