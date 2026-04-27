# Security Policy — openclaw-middleware-suite

## Supported versions

| Version | Security fixes |
|---------|---------------|
| Latest (`main`) | Yes |
| Older releases | No — please upgrade |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**
Public issues are visible to the internet before a fix is available.

Use GitHub's private vulnerability reporting instead:

**[Report a vulnerability (private)](https://github.com/Sapience-AI/openclaw-middleware-suite/security/advisories/new)**

This opens a private channel between you and the maintainers. No public
disclosure occurs until we have had time to investigate and release a fix.

### What to include

- A clear description of the vulnerability and its potential impact.
- The affected version(s) or commit SHA.
- Step-by-step reproduction instructions or a minimal proof-of-concept.
- Any suggested mitigations you have identified (optional but appreciated).

### What to expect

| Stage | Timeline |
|-------|----------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 5 business days |
| Remediation timeline communicated | Within 7 business days |
| Target fix release | Within 30 days (critical) / 90 days (others) |

We follow **coordinated disclosure**: we ask that you give us the timelines
above before public disclosure. We will credit reporters in release notes
unless you prefer to remain anonymous.

## Scope

In scope:

- Prompt-injection bypass in the guardrail middleware.
- PII leakage through the redaction middleware.
- HITL approval bypass or privilege escalation.
- Dependency vulnerabilities with a known exploit in the published package.
- Supply-chain issues in the build or release pipeline.

Out of scope: UI bugs, performance issues, or theoretical vulnerabilities
with no demonstrated impact.

## Security design notes

This library uses a zero-telemetry, local-state-only architecture.
No data leaves the process unless explicitly configured by the caller.
See the architecture documentation for details.
