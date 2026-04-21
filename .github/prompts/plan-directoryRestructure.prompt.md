# Plan: Directory Restructure for Multi-Middleware Architecture

Restructure the Sapience Middleware Suite from a monolithic HITL-centric layout into a multi-middleware architecture where HITL becomes one middleware module alongside future ToolCallLimit, ModelFallback, and ContextEditing middlewares. Introduce a formal `Middleware` interface, extract shared infrastructure, and update the plugin/CLI layers to orchestrate multiple middlewares.

## Decisions

- Risk scorers (DestructiveClassifier, IrreversibilityScorer, etc.) **stay inside HITL** — extract later only when needed
- **Formal Middleware interface** with lifecycle hooks (`beforeToolCall`, `afterToolCall`, etc.)
- Future middlewares get **empty directories only** (no stubs)
- CLI uses **flat commands with `--middleware` flag** (e.g., `sapience audit --middleware hitl`)
- Package renamed **`sapience-middleware` → `sapience-middleware-suite`**

---

## Target Directory Structure

```
src/
  index.ts                          # Re-exports from shared + middlewares
  types.ts                          # Base Middleware interface + shared types

  shared/                           # Cross-cutting infrastructure
    Logger.ts                       # (from core/Logger.ts)
    config.ts                       # MiddlewareRegistry + base config
    storage/
      PolicyStore.ts                # (from storage/)
      DecisionLog.ts                # (from storage/)
      StatsTracker.ts               # (from storage/)

  middlewares/
    hitl/                           # Human-in-the-Loop
      index.ts                      # HitlMiddleware class (implements Middleware)
      types.ts                      # HITL-specific types
      config.ts                     # DEFAULT_POLICY
      Interceptor.ts, Arbitrator.ts, ApprovalQueue.ts,
      TotpManager.ts, TrustRateLimiter.ts,
      DestructiveClassifier.ts, IrreversibilityScorer.ts,
      MemoryRiskForecaster.ts, BrowserChallengeDetector.ts
      storage/
        BrowserSessionStore.ts

    tool-call-limit/                # (empty — future)
    model-fallback/                 # (empty — future)
    context-editing/                # (empty — future)

  plugin/                           # OpenClaw bridge (updated for pipeline)
  cli/                              # CLI (updated with --middleware flag)
```

---

## Steps

### Phase 1: Foundation (no deps, parallelizable)

1. Create directory structure: `src/shared/`, `src/shared/storage/`, `src/middlewares/hitl/`, `src/middlewares/hitl/storage/`, and empty future dirs
2. Define `Middleware` interface in `src/types.ts` with hooks: `name`, `version`, `initialize()`, `beforeToolCall()`, `afterToolCall()`, `getStatus()`, `shutdown()` *(parallel with 1)*
3. Rename package in `package.json` to `sapience-middleware-suite` *(parallel with 1)*

### Phase 2: Extract Shared Infrastructure (depends on Phase 1)

4. Move `src/core/Logger.ts` → `src/shared/Logger.ts`, update all imports
5. Move `PolicyStore.ts`, `DecisionLog.ts`, `StatsTracker.ts` → `src/shared/storage/`, update imports *(parallel with 4)*
6. Create `src/shared/config.ts` with `MiddlewareRegistry` that loads, initializes, and orchestrates middlewares in pipeline order

### Phase 3: Relocate HITL (depends on Phase 2)

7. Split types: extract HITL-specific types (`Decision`, `SecurityRule`, `InterventionMetadata`, `ApprovalState`, etc.) from `src/types.ts` → `src/middlewares/hitl/types.ts`
8. Move `src/config.ts` → `src/middlewares/hitl/config.ts` *(parallel with 7)*
9. Move all 9 core modules from `src/core/` → `src/middlewares/hitl/` *(depends on 7-8)*
10. Move `BrowserSessionStore.ts` → `src/middlewares/hitl/storage/` *(parallel with 9)*
11. Create `src/middlewares/hitl/index.ts` — `HitlMiddleware` class implementing `Middleware`, wrapping `Interceptor.evaluate()` in `beforeToolCall()`

### Phase 4: Update Orchestration (depends on Phase 3)

12. Update `plugin/index.ts` — use `MiddlewareRegistry`, refactor `createToolCallHook()` to iterate the middleware pipeline
13. Update `plugin/tool-interceptor.ts` — delegate to pipeline instead of calling Interceptor directly *(depends on 12)*
14. Update `plugin/config-manager.ts` — support per-middleware config sections *(parallel with 12)*

### Phase 5: Update CLI (depends on Phase 3)

15. Add `--middleware` flag to `cli/index.ts`, default to `hitl` for backward compat
16. Update `cli/init.ts` — multi-middleware setup wizard *(parallel with 15)*
17. Update all command files (`audit`, `policy`, `reset`, `stats`, `toggle`) with `--middleware` flag routing *(depends on 15)*

### Phase 6: Exports, Tests & Cleanup (depends on Phases 4-5)

18. Restructure `src/index.ts` — re-export from `shared/` and `middlewares/hitl/`, maintain backward-compatible named exports
19. Update all 7 test files with new import paths *(parallel with 18)*
20. Update `scripts/demo-destructive.ts` imports *(parallel with 18)*
21. Delete empty `src/core/` and `src/storage/` directories
22. Update `openclaw.plugin.json`, `tsconfig.json` (optional path aliases), `README.md`, `CONTRIBUTING.md`

---

## File Movement Map (15 files)

| Current | New |
|---|---|
| `src/core/Logger.ts` | `src/shared/Logger.ts` |
| `src/storage/PolicyStore.ts` | `src/shared/storage/PolicyStore.ts` |
| `src/storage/DecisionLog.ts` | `src/shared/storage/DecisionLog.ts` |
| `src/storage/StatsTracker.ts` | `src/shared/storage/StatsTracker.ts` |
| `src/config.ts` | `src/middlewares/hitl/config.ts` |
| `src/core/Interceptor.ts` | `src/middlewares/hitl/Interceptor.ts` |
| `src/core/Arbitrator.ts` | `src/middlewares/hitl/Arbitrator.ts` |
| `src/core/ApprovalQueue.ts` | `src/middlewares/hitl/ApprovalQueue.ts` |
| `src/core/TotpManager.ts` | `src/middlewares/hitl/TotpManager.ts` |
| `src/core/TrustRateLimiter.ts` | `src/middlewares/hitl/TrustRateLimiter.ts` |
| `src/core/DestructiveClassifier.ts` | `src/middlewares/hitl/DestructiveClassifier.ts` |
| `src/core/IrreversibilityScorer.ts` | `src/middlewares/hitl/IrreversibilityScorer.ts` |
| `src/core/MemoryRiskForecaster.ts` | `src/middlewares/hitl/MemoryRiskForecaster.ts` |
| `src/core/BrowserChallengeDetector.ts` | `src/middlewares/hitl/BrowserChallengeDetector.ts` |
| `src/storage/BrowserSessionStore.ts` | `src/middlewares/hitl/storage/BrowserSessionStore.ts` |

`src/types.ts` is **split** (base stays, HITL types extracted). `src/index.ts`, `plugin/*`, `cli/*` are **modified in-place**.

---

## Middleware Interface Design

```typescript
// src/types.ts — Base Middleware contract

export interface MiddlewareContext {
  toolName: string;
  moduleName: string;
  methodName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface MiddlewareResult {
  block: boolean;
  reason?: string;
  modifiedParams?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface Middleware {
  readonly name: string;
  readonly version: string;
  initialize(config: Record<string, unknown>): Promise<void>;
  beforeToolCall?(context: MiddlewareContext): Promise<MiddlewareResult>;
  afterToolCall?(context: MiddlewareContext, result: unknown): Promise<void>;
  getStatus(): { enabled: boolean; stats?: Record<string, unknown> };
  shutdown?(): Promise<void>;
}
```

---

## Pipeline Orchestration

```
before_tool_call hook → MiddlewareRegistry.executePipeline(context)
  → ToolCallLimit.beforeToolCall()    // rate limit check
  → ContextEditing.beforeToolCall()   // may modify params
  → HITL.beforeToolCall()             // may block for human approval
  → Return final result to OpenClaw
```

The `MiddlewareRegistry` in `src/shared/config.ts` executes the pipeline sequentially — if any middleware returns `{ block: true }`, the pipeline short-circuits.

---

## Verification

1. `npm run build` — zero TypeScript errors
2. `npm run lint` — no lint regressions
3. `node --test test/` — all 7 test suites pass
4. `node scripts/demo-destructive.ts` — demo runs successfully
5. Backward-compat: `import { Interceptor } from 'sapience-middleware-suite'` resolves via re-exports
6. CLI: both `sapience-middleware audit` and `sapience-middleware audit --middleware hitl` work

---

## Scope

- **Included**: Directory restructure, file moves, Middleware interface, pipeline orchestration, CLI `--middleware` flag, package rename, empty future dirs, doc updates
- **Excluded**: Implementing ToolCallLimit/ModelFallback/ContextEditing logic, extracting risk scorers to shared, new features
