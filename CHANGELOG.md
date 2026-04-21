# Changelog

All notable changes to the Sapience AI Suite are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Output Guardrail: Metadata scrubber for assistant responses
- Enhanced confidence filtering for secret detection
- Chunked scanning improvements for large payloads
- AWS secret detection patterns
- Role impersonation detection gaps fixed
- Extended egress allowlist configuration

### Changed
- Improved error handling in tool-call limits
- Updated TypeScript strict mode compliance

### Fixed
- High-impact security loopholes
- Confidence filter edge cases
- Canary tracking re-redaction logic

## [1.0.0] - 2026-04-09

### Added
- Initial release of Sapience AI Suite
- **HITL Middleware**: Human-in-the-loop approval system
  - Terminal TTY prompts for destructive actions
  - Channel-based approval (WhatsApp, Telegram)
  - TOTP token generation for high-risk actions
  - Interactive approval flows with YES/NO/ALLOW/CONFIRM
  
- **Guardrail Protection**: Multi-layer security scanning
  - Sensitive path blocking (.ssh, .env, .aws/credentials)
  - Egress control with domain allowlist
  - Destructive command detection
  - Role impersonation detection
  - Canary tracking for redacted content
  
- **Tool Call Limiting**: Dual-scope budgeting
  - Session-level persistent limits
  - Request-level transient limits
  - Soft limits (warnings) at 90%
  - Hard limits (blocking) at 100%
  
- **Browser Challenge Detection**: Risky state detection
  
- **PII Sanitizer**: Personal information detection and masking
  
- **Irreversibility Scoring**: Risk assessment for actions
  
- **Memory Risk Forecasting**: Pre-turn drift/salami/commitment analysis

### Security
- Zero-trust architecture: every action evaluated
- Synchronous blocking: agent waits for approval
- Immutable audit trails (JSONL append-only)
- Fail-secure defaults
- Encrypted browser session persistence

### CLI Features
- `sai init`: Interactive setup wizard
- `sai hitl policy`: Policy management
- `sai hitl stats`: Statistics viewer
- `sai hitl audit`: Audit trail inspection
- `sai configure`: Non-interactive setup for automation
- `sai disable/enable`: Middleware toggle

### Documentation
- Comprehensive README with quick start
- Architecture documentation
- API documentation
- CLI command reference
- Security policy customization guide
- Contributing guidelines

### Testing
- Development script for demo scenarios
- Local testing via `npm run demo:destructive`

## [0.x.x] - Pre-release versions

Earlier development versions were used for research and testing within Sapience AI Discovery Team.

---

## Upgrade Instructions

### From v0.x to v1.0

If you were using pre-release versions:

```bash
# Update the plugin
sai upgrade

# Run setup again (optional, for new features)
sai init

# Reload gateway
openclaw gateway restart
```

### Breaking Changes

None in v1.0 — all changes are backward compatible.

## Future Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features and improvements.
