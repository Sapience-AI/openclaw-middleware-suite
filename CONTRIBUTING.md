# Contributing to OpenClaw Middleware Suite

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Table of Contents

- [Local Setup](#local-setup)
- [Test Commands](#test-commands)
- [Pull Request Process](#pull-request-process)
- [Branch Naming Convention](#branch-naming-convention)
- [Code Style Guidelines](#code-style-guidelines)
- [Project Structure](#project-structure)
- [Contributor sign-off (DCO)](#contributor-sign-off-dco)
- [Third-party licenses](#third-party-licenses)

---

## Local Setup

### Prerequisites

- **Node.js** ≥ 18.0.0 — [download](https://nodejs.org/) (matches `engines.node` in `package.json`)
- **npm** 9+ (ships with Node 18)
- **Git** 2.30+

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/Sapience-AI/openclaw-middleware-suite.git
cd openclaw-middleware-suite

# 2. Install dependencies
npm install

# 3. Build the project (compiles backend with tsc + bundles dashboard with Vite)
npm run build

# 4. Run the full test suite (build + test)
npm test

# 5. (Optional) Run the setup wizard
node dist/index.js configure --non-interactive --json
```

The published binary is `sai` (`bin.sai → ./dist/index.js`). After `npm link`, the same wizard is available as `sai configure …`.

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

We use **Node.js' built-in test runner** (`node:test`) with `.test.mjs` files. Tests import from `dist/`, so a build step always runs first (either via `npm test` or by hand).

### Full Suite

```bash
# Build + run all tests (recommended before every PR)
npm test
```

### Coverage

```bash
# Generate a coverage report (text + lcov + json-summary, gated at 75% lines / 70% branches)
npm run test:coverage

# Same but without coverage gates — useful while iterating
npm run test:coverage:report
```

### Individual Suites

```bash
# Per-middleware (each has its own folder under test/)
node --test test/guardrail/*.test.mjs        # Guardrail (scanners + guards + CLI)
node --test test/hitl/*.test.mjs             # HITL (policy, approval flow, TOTP, classifier)
node --test test/pii-sanitizer/*.test.mjs    # PII Sanitizer (regex/heuristic/prefix + integration)
node --test test/tool-call-limit/*.test.mjs  # Tool Call Limit (session + request budgets)
node --test test/model-routing/*.test.mjs    # Model Routing (keyword trie, scoring, density clustering)
node --test test/context-editing/*.test.mjs  # Context Editing (compaction simulation)

# Cross-cutting
node --test test/integration/*.test.mjs      # Multi-middleware pipeline integration
node --test test/public-api.test.mjs         # Asserts the documented public surface stays intact

# Shared test helpers live in test/_helpers/ — not run directly.
```

### Other Commands

| Command | Description |
|---|---|
| `npm run build` | Backend (`tsc`) + dashboard (Vite) → `dist/` |
| `npm run build:backend` | Just `tsc` (backend only) |
| `npm run build:dashboard` | Just the Vite dashboard bundle |
| `npm run dev:dashboard` | Live-reloading dashboard on port 5173 |
| `npm run lint` | Run ESLint on `src/` |
| `npm run format` | Format `src/` with Prettier |
| `npx tsc --noEmit` | Type-check without emitting |

### Writing Tests

- Place test files in `test/<middleware-name>/` (or `test/integration/`) with a `.test.mjs` extension
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

If your test exercises something that should be reachable from a published-package consumer, add an assertion to `test/public-api.test.mjs` so we catch accidental subpath surface regressions.

---

## Pull Request Process

1. Branch from `main` (see [naming convention](#branch-naming-convention))
2. Make changes, build, and test:
   ```bash
   npm run build
   npx tsc --noEmit     # Must report zero errors
   npm test             # Must report zero failures
   npm run lint         # Must pass (warnings are OK; errors are not)
   ```
3. Push your branch and open a PR against `main`
4. Fill out the PR template completely
5. Request a review from at least one maintainer
6. Squash-merge into `main` once approved
7. Delete the feature branch after merge

### PR Checklist

- [ ] TypeScript compiles without errors (`npx tsc --noEmit`)
- [ ] All tests pass (currently **401 / 401** as of v1.0)
- [ ] New features have corresponding tests
- [ ] Public surface changes are reflected in `test/public-api.test.mjs` and `README.md`
- [ ] No secrets, credentials, or `.env` files committed
- [ ] `NOTICE` updated if code is derived from a third-party project (with per-file attribution headers)

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
- Branch from `main`, merge back to `main` (we use a single-trunk flow — there is no `develop` branch)

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

- **Strict mode** enabled (`strict: true` in `tsconfig.json`, plus the full `noUnused*` / `noImplicit*` family)
- **Target**: ES2022
- **Module system**: ESM — `package.json` has `"type": "module"`, `tsconfig.json` uses `"module": "Node16"` and `"moduleResolution": "Node16"`. Internal imports use the `.js` suffix even for `.ts` source files.
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

### Copyright Headers

Every `.ts` / `.tsx` file under `src/` carries an Apache-2.0 copyright header.

- **Files originally written for this project** start with:
  ```
  /*
   * Copyright (c) 2026 Sapience AI Corporation
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *     http://www.apache.org/licenses/LICENSE-2.0
   */
  ```
- **Files derived from a third-party project** keep the upstream copyright on top and add a `Modifications copyright (c) 2026 Sapience AI Corporation` line, plus a comment identifying the upstream source. The full attribution lives in `NOTICE`. If your PR ports new code from an upstream project, update `NOTICE` and the per-file header in the same PR.

---

## Project Structure

```
openclaw-middleware-suite/
├── src/
│   ├── index.ts                   # Public root entry + `sai` CLI orchestrator (shebang)
│   ├── types.ts                   # Shared type definitions (Middleware, MiddlewareResult, …)
│   ├── public/                    # Per-middleware public entries (the npm subpath surface)
│   │   ├── hitl.ts
│   │   ├── context-editing.ts
│   │   ├── model-routing.ts
│   │   ├── guardrail.ts
│   │   ├── pii-sanitizer.ts
│   │   └── tool-call-limit.ts
│   ├── plugin/                    # OpenClaw plugin entry + plugin gating logic
│   │   ├── index.ts               # Plugin manifest + hook composition
│   │   └── config-manager.ts      # Plugin-level on/off flag + lifecycle
│   ├── middlewares/
│   │   ├── hitl/                  # Human-in-the-Loop approval system
│   │   ├── guardrail/             # Security guardrails & scanners (guards/ lives here)
│   │   ├── pii-sanitizer/         # PII/DLP detection & redaction
│   │   ├── tool-call-limit/       # Tool call budget enforcement
│   │   ├── model-routing/         # Complexity-based model selection + proxy
│   │   └── context-editing/       # ICC-driven context window compaction
│   ├── dashboard/                 # Preact SPA served by the gateway
│   │   ├── index.html
│   │   ├── index.tsx
│   │   ├── vite.config.ts         # Builds into dist/dashboard/
│   │   ├── components/            # Reusable UI components (Sidebar, Modal, Toast, …)
│   │   ├── pages/                 # Per-middleware admin pages
│   │   ├── services/              # api / sse / formatters
│   │   └── public/                # Static assets (favicon, sai-logo.svg)
│   └── shared/                    # Cross-cutting utilities, CLI shared bits, storage
│       ├── Logger.ts              # Winston wrapper
│       ├── cli/                   # `sai init` / `sai enable|disable` / shared CLI plumbing
│       ├── server/                # gateway HTTP + SSE + dashboard-static + openclaw-sync
│       └── storage/               # ConfigStore (the unified disk overlay), paths, cleanup
├── test/
│   ├── _helpers/                  # Shared test fixtures and utilities
│   ├── public-api.test.mjs        # Asserts the documented npm subpath surface stays intact
│   ├── integration/               # Multi-middleware pipeline integration tests
│   ├── guardrail/                 # Guardrail tests (unit + scanner + guards)
│   ├── hitl/                      # HITL tests
│   ├── pii-sanitizer/             # PII sanitizer tests
│   ├── tool-call-limit/           # Tool call limit tests
│   ├── model-routing/             # Model routing tests
│   └── context-editing/           # Context editing tests
├── docs/                          # Extended documentation
├── dist/                          # Compiled output (git-ignored)
├── .github/                       # CI, issue templates, PR template
├── package.json                   # Subpath exports declared under `exports`
├── tsconfig.json                  # Strict + Node16 ESM
├── openclaw.plugin.json           # OpenClaw plugin manifest
├── README.md
└── NOTICE                         # Third-party attributions (Reins / Manifest / ClawRouter / Shield / OpenGuardrails)
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

## Contributor sign-off (DCO)

Every commit in every pull request to this repo must include a
`Signed-off-by:` line. We use the **Developer Certificate of Origin
v1.1** (DCO) as the inbound contribution agreement — a lightweight
attestation that you have the right to contribute the patch under
this project's license (Apache-2.0). No CLA, no lawyers, no signup —
just a one-line trailer on each commit.

CI rejects any PR whose commits are missing the trailer; see
[`.github/workflows/dco.yml`](./.github/workflows/dco.yml).

### How to sign off

Pass `-s` (or `--signoff`) when committing:

```bash
git commit -s -m "fix: typo in README"
```

This appends a trailer like:

```
Signed-off-by: Random J Developer <random@developer.example.org>
```

Use the same name + email you've configured in `git config user.name`
and `git config user.email` (most editors / IDEs already set these).

If you forgot on the most recent commit, amend it:

```bash
git commit --amend --signoff
git push --force-with-lease
```

If multiple commits in the PR are missing sign-offs, rebase and
sign each:

```bash
git rebase HEAD~N --signoff   # N = number of commits to rewrite
git push --force-with-lease
```

### What you're attesting to

The DCO v1.1 text — by adding the `Signed-off-by:` trailer you are
attesting that:

> Developer Certificate of Origin
> Version 1.1
>
> Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
>
> Everyone is permitted to copy and distribute verbatim copies of this
> license document, but changing it is not allowed.
>
>
> Developer's Certificate of Origin 1.1
>
> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I
>     have the right to submit it under the open source license
>     indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best
>     of my knowledge, is covered under an appropriate open source
>     license and I have the right under that license to submit that
>     work with modifications, whether created in whole or in part
>     by me, under the same open source license (unless I am
>     permitted to submit under a different license), as indicated
>     in the file; or
>
> (c) The contribution was provided directly to me by some other
>     person who certified (a), (b) or (c) and I have not modified
>     it.
>
> (d) I understand and agree that this project and the contribution
>     are public and that a record of the contribution (including all
>     personal information I submit with it, including my sign-off) is
>     maintained indefinitely and may be redistributed consistent with
>     this project or the open source license(s) involved.

Source: <https://developercertificate.org>.

We don't require a CLA or contributor agreement beyond this. If you
contribute on behalf of a company that requires explicit copyright
assignment, please open a discussion before sending the PR.

---

## Third-party licenses

`NOTICE` lists every project this suite is **derived from** (Reins,
Manifest, ClawRouter, OpenClaw Shield, OpenGuardrails) and cites
per-file Apache §4(b) / MIT attribution headers. In addition, every
package declared in `package.json` ships under its own license; the
authoritative text for each transitive dep lives under that package's
folder in `node_modules/`. Source-only distribution (npm package +
GitHub source) treats this as sufficient — recipients install the
deps themselves and inherit each one's license terms directly from
the upstream registry.

**However, before publishing any artifact that bundles dependencies**,
generate a `THIRD_PARTY_LICENSES.md` covering every transitive that
ends up in the artifact. Bundled artifacts include:

- A single-file bundle (e.g. esbuild `--bundle`, ncc, pkg).
- A Docker / OCI container image with `node_modules/` copied in.
- A native installer (electron-builder, Tauri bundle, etc.).
- Anything that distributes the dep code rather than declaring deps
  for the recipient to install.

Recommended generators (any one is fine — pick what your release
workflow already has):

```bash
# Lightweight dump of every dep + license + repository URL
npx license-checker --production --json > THIRD_PARTY_LICENSES.json

# Spec-quality, pluggable, recommended for compliance audits
npx licensee --json --license

# Full SBOM-class tooling — overkill for our size today, but correct
npx oss-review-toolkit analyze
```

The npm + GitHub release workflows in this repo do **not** currently
bundle deps, so this section is forward-looking. If you change that —
add a CI step that regenerates `THIRD_PARTY_LICENSES.md` and fails the
build when it drifts from the lockfile.

---

## Questions?

- **Issues**: [GitHub Issues](https://github.com/Sapience-AI/openclaw-middleware-suite/issues) for bugs/features
- **Docs**: Open a [documentation issue](https://github.com/Sapience-AI/openclaw-middleware-suite/issues/new?template=docs_improvement.yml) if something is unclear
- **Email**: discovery.shariq.ali@sapienceai.co for sensitive topics

Thank you for making the OpenClaw Middleware Suite better!
