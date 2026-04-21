# Contributing to Sapience AI Suite

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Table of Contents

- [Local Setup](#local-setup)
- [Test Commands](#test-commands)
- [Pull Request Process](#pull-request-process)
- [Branch Naming Convention](#branch-naming-convention)
- [Code Style Guidelines](#code-style-guidelines)
- [Project Structure](#project-structure)

---

## Local Setup

### Prerequisites

- **Node.js** 20.x (LTS) — [download](https://nodejs.org/)
- **npm** 10+ (ships with Node 20)
- **Git** 2.30+

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/Sapience-AI-Discovery-Team/Openclaw-Middleware-Suite.git
cd Openclaw-Middleware-Suite

# 2. Install dependencies
npm install

# 3. Build the project
npm run build

# 4. Run the full test suite (build + test)
npm test

# 5. (Optional) Run the setup wizard
node dist/index.js configure --non-interactive --json
```

### Environment Variables (optional)

| Variable | Description | Default |
|---|---|---|
| `OPENCLAW_HOME` | OpenClaw config directory | `~/.openclaw` |
| `OPENCLAW_CONFIG` | Path to `openclaw.json` | `$OPENCLAW_HOME/openclaw.json` |
| `LOG_LEVEL` | Winston log level | `info` |
| `SAPIENCE_MW_DESTRUCTIVE_GATING` | Enable destructive command classifier | `off` |
| `SAPIENCE_MW_BULK_THRESHOLD` | Bulk operation count threshold | `20` |

---

## Test Commands

We use **Node.js built-in test runner** (`node:test`) with `.test.mjs` files.

### Full Suite

```bash
# Build + run all tests (recommended before every PR)
npm test
```

### Individual Middleware

```bash
# Guardrail (unit tests + output scrubber + CLI + guards + scanners)
node --test test/guardrail/*.test.mjs

# Human-in-the-Loop (policy, approval flow, TOTP, destructive classifier)
node --test test/hitl/*.test.mjs

# PII Sanitizer (regex, heuristic, prefix scanning, integration)
node --test test/pii-sanitizer/*.test.mjs

# Tool Call Limits (session/request budgets, tracker)
node --test test/tool-call-limit/*.test.mjs

# Model Routing (keyword trie, request scoring, density clustering)
node --test test/model-routing/*.test.mjs

# Context Editing (compaction simulation)
node --test test/context-editing/*.test.mjs
```

### Other Commands

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run lint` | Run ESLint on `src/` |
| `npm run format` | Format code with Prettier |
| `npx tsc --noEmit` | Type-check without emitting |

### Writing Tests

- Place test files in `test/<middleware-name>/` with a `.test.mjs` extension
- Use `node:test` and `node:assert/strict` — no external test frameworks
- Tests import from `dist/` (compiled output), so run `npm run build` first
- Use `path.resolve('dist')` for location-independent imports:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const { MyModule } = await import(u('middlewares/my-module/MyModule.js'));

test('it works', () => {
  assert.equal(MyModule.doThing(), true);
});
```

---

## Pull Request Process

1. Branch from `develop` (see [naming convention](#branch-naming-convention))
2. Make changes, build, and test:
   ```bash
   npm run build
   npx tsc --noEmit     # Must report zero errors
   npm test             # Must report zero failures
   npm run lint         # Must pass
   ```
3. Push your branch and open a PR against `develop`
4. Fill out the PR template completely
5. Request a review from at least one maintainer
6. Squash-merge into `develop` once approved
7. Delete the feature branch after merge

### PR Checklist

- [ ] TypeScript compiles without errors
- [ ] All tests pass (237/237 as of v1.0)
- [ ] New features have corresponding tests
- [ ] No secrets, credentials, or `.env` files committed
- [ ] Documentation updated if public API changed

---

## Branch Naming Convention

| Prefix | Purpose | Example |
|---|---|---|
| `feat/` | New feature | `feat/totp-approval-flow` |
| `fix/` | Bug fix | `fix/argshash-mismatch` |
| `refactor/` | Code restructuring | `refactor/consolidate-guardrail-tests` |
| `docs/` | Documentation only | `docs/update-readme` |
| `test/` | Test additions/fixes | `test/oob-approval-concurrency` |
| `chore/` | Build, CI, deps | `chore/upgrade-typescript` |
| `release/` | Release preparation | `release/v1.1.0` |

### Rules

- Use lowercase with hyphens: `feat/my-feature` not `feat/MyFeature`
- Keep it short but descriptive
- Branch from `develop`, merge back to `develop`
- `main` receives merges from `develop` only (release flow)

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add egress control for curl/wget
fix: prevent TOTP timeout race condition
docs: expand CLI reference documentation
test: add unit tests for secret detection
refactor: consolidate guardrail test directories
```

---

## Code Style Guidelines

### TypeScript

- **Strict mode** enabled (`strict: true` in `tsconfig.json`)
- **Target**: ES2022, CommonJS module output
- Use `interface` over `type` for object shapes when possible
- Prefer `const` over `let`; never use `var`
- Export types explicitly: `export type { MyType }`
- No `any` without explicit justification

### Formatting (enforced by Prettier)

- 2-space indentation
- Single quotes
- Trailing commas
- 100-character line width

### Linting (enforced by ESLint)

- `@typescript-eslint` recommended rules
- No unused variables (prefix with `_` if intentionally unused)

### Naming Conventions

- `camelCase` for variables, functions, parameters
- `PascalCase` for classes, interfaces, types, enums
- `UPPER_SNAKE_CASE` for constants
- Descriptive file names: `DestructiveClassifier.ts` not `classifier.ts`

### Logging

- Use the shared Winston logger: `import { logger } from '../../shared/Logger'`
- Log levels: `error` > `warn` > `info` > `debug`
- Include structured context: `logger.info('message', { key: value })`

---

## Project Structure

```
Openclaw-Middleware-Suite/
├── src/
│   ├── index.ts                  # Public API exports & CLI entry
│   ├── types.ts                  # Shared type definitions
│   ├── plugin/                   # OpenClaw plugin hooks
│   │   ├── index.ts              # Plugin registration & hook composition
│   │   └── guards/               # L2/L3 guard implementations
│   ├── middlewares/
│   │   ├── hitl/                 # Human-in-the-Loop approval system
│   │   ├── guardrail/            # Security guardrails & scanners
│   │   ├── pii-sanitizer/        # PII/DLP detection & redaction
│   │   ├── tool-call-limit/      # Tool call budget enforcement
│   │   ├── model-routing/        # Intelligent model selection
│   │   └── context-editing/      # Context window management
│   └── shared/                   # Shared utilities, CLI, storage
├── test/
│   ├── guardrail/                # Guardrail tests (unit + legacy)
│   ├── hitl/                     # HITL tests
│   ├── pii-sanitizer/            # PII sanitizer tests
│   ├── tool-call-limit/          # Tool call limit tests
│   ├── model-routing/            # Model routing tests
│   └── context-editing/          # Context editing tests
├── docs/                         # Extended documentation
├── dist/                         # Compiled output (git-ignored)
├── .github/                      # CI, issue templates, PR template
├── package.json
├── tsconfig.json
└── openclaw.plugin.json          # OpenClaw plugin manifest
```

---

## Security Considerations

When contributing security-related code:

1. **Don't commit secrets** in test data or examples
2. **Consider edge cases** that attackers might exploit
3. **Document assumptions** about trust boundaries
4. **Ask for review** if uncertain about security implications

**Report vulnerabilities privately**: email discovery.shariq.ali@sapienceai.co

---

## Questions?

- **Issues**: [GitHub Issues](https://github.com/Sapience-AI-Discovery-Team/Openclaw-Middleware-Suite/issues) for bugs/features
- **Docs**: Open a [documentation issue](https://github.com/Sapience-AI-Discovery-Team/Openclaw-Middleware-Suite/issues/new?template=docs_improvement.yml) if something is unclear
- **Email**: discovery.shariq.ali@sapienceai.co for sensitive topics

Thank you for making Sapience AI Suite better!
