// Mirrors clawhub/convex/lib/moderationEngine.ts (engine version v2.4.22).
// Runs the regex/static-pattern security checks ClawHub applies to a published
// package, against the files this package would publish to npm. A finding with
// status "malicious" should block release; "suspicious" needs review.
//
// Source of truth: clawhub/convex/lib/moderationEngine.ts +
//                  clawhub/convex/lib/moderationReasonCodes.ts +
//                  clawhub/packages/schema/src/textFiles.ts
//
// Run: node scripts/clawhub-static-scan.mjs

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────────────────────────────────────
// reason codes
// ─────────────────────────────────────────────────────────────────────────────
const MODERATION_ENGINE_VERSION = 'v2.4.22';

const REASON_CODES = {
  DANGEROUS_EXEC: 'suspicious.dangerous_exec',
  DYNAMIC_CODE: 'suspicious.dynamic_code_execution',
  GENERATED_SOURCE_TEMPLATE: 'suspicious.generated_source_template_injection',
  EXPOSED_RESOURCE_IDENTIFIER: 'suspicious.exposed_resource_identifier',
  DESTRUCTIVE_DELETE_COMMAND: 'suspicious.destructive_delete_command',
  UNSAFE_BROWSER_TEXT_INPUT: 'suspicious.unsafe_browser_text_input',
  EXPOSED_SECRET_LITERAL: 'suspicious.exposed_secret_literal',
  CREDENTIAL_EXPOSURE_INSTRUCTIONS: 'suspicious.credential_exposure_instructions',
  BROWSER_CREDENTIAL_AUTOMATION: 'suspicious.browser_credential_automation',
  SECRET_ARGV_EXPOSURE: 'suspicious.secret_argv_exposure',
  HOST_PLATFORM_SOURCE_PATCH: 'suspicious.host_platform_source_patch',
  BROWSER_FILE_RENDER: 'suspicious.browser_file_render',
  UNSAFE_FILE_WRITE: 'suspicious.unsafe_file_write',
  INSECURE_TLS_VERIFICATION: 'suspicious.insecure_tls_verification',
  AUTONOMOUS_CREDENTIAL_EGRESS: 'suspicious.autonomous_credential_egress',
  HARDCODED_OPERATOR_BILLING: 'suspicious.hardcoded_operator_billing',
  REMOTE_RECIPE_EXECUTION: 'suspicious.remote_recipe_execution',
  CONFIRMATION_BYPASS: 'suspicious.confirmation_bypass',
  CREDENTIAL_HARVEST: 'suspicious.env_credential_access',
  EXFILTRATION: 'suspicious.potential_exfiltration',
  OBFUSCATED_CODE: 'suspicious.obfuscated_code',
  SUSPICIOUS_NETWORK: 'suspicious.nonstandard_network',
  CRYPTO_MINING: 'malicious.crypto_mining',
  INJECTION_INSTRUCTIONS: 'suspicious.prompt_injection_instructions',
  SUSPICIOUS_INSTALL_SOURCE: 'suspicious.install_untrusted_source',
  MANIFEST_PRIVILEGED_ALWAYS: 'suspicious.privileged_always',
  MALICIOUS_INSTALL_PROMPT: 'malicious.install_terminal_payload',
  KNOWN_BLOCKED_SIGNATURE: 'malicious.known_blocked_signature',
  DEP_NOT_FOUND: 'suspicious.dep_not_found_on_registry',
};

const MALICIOUS_CODES = new Set([
  REASON_CODES.CRYPTO_MINING,
  REASON_CODES.MALICIOUS_INSTALL_PROMPT,
  REASON_CODES.KNOWN_BLOCKED_SIGNATURE,
]);

function normalizeReasonCodes(codes) {
  return Array.from(new Set(codes.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function summarizeReasonCodes(codes) {
  if (codes.length === 0) return 'No suspicious patterns detected.';
  const top = codes.slice(0, 3).join(', ');
  const extra = codes.length > 3 ? ` (+${codes.length - 3} more)` : '';
  return `Detected: ${top}${extra}`;
}

function verdictFromCodes(codes) {
  const normalized = normalizeReasonCodes(codes);
  if (normalized.some((c) => MALICIOUS_CODES.has(c) || c.startsWith('malicious.'))) {
    return 'malicious';
  }
  if (normalized.length > 0) return 'suspicious';
  return 'clean';
}

// ─────────────────────────────────────────────────────────────────────────────
// text-file extension list (from clawhub-schema)
// ─────────────────────────────────────────────────────────────────────────────
const TEXT_FILE_EXTENSIONS = new Set([
  'md',
  'mdx',
  'txt',
  'json',
  'json5',
  'yaml',
  'yml',
  'toml',
  'js',
  'cjs',
  'mjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'sh',
  'r',
  'rb',
  'go',
  'rs',
  'swift',
  'kt',
  'java',
  'cs',
  'cpp',
  'c',
  'h',
  'hpp',
  'sql',
  'csv',
  'ini',
  'cfg',
  'env',
  'xml',
  'html',
  'css',
  'scss',
  'sass',
  'svg',
]);

function isTextFile(path) {
  const lower = path.toLowerCase();
  const parts = lower.split('.');
  if (parts.length < 2) return false;
  return TEXT_FILE_EXTENSIONS.has(parts.at(-1));
}

// ─────────────────────────────────────────────────────────────────────────────
// regex patterns (verbatim from moderationEngine.ts)
// ─────────────────────────────────────────────────────────────────────────────
const MANIFEST_EXTENSION = /\.(json|yaml|yml|toml)$/i;
const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i;
const CODE_EXTENSION = /\.(js|ts|mjs|cjs|mts|cts|jsx|tsx|py|sh|bash|zsh|rb|go)$/i;
const STANDARD_PORTS = new Set([80, 443, 8080, 8443, 3000]);
const RAW_IP_URL_PATTERN = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|["'])/i;
const CGNAT_HTTP_URL_PATTERN =
  /http:\/\/100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?::\d+)?(?:\/[^\s"'`]*)?/i;
const INSTALL_PACKAGE_PATTERN = /installer-package\s*:\s*https?:\/\/[^\s"'`]+/i;
const GENERATED_SOURCE_PLACEHOLDER_PATTERN =
  /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=.*["']\$\{[A-Za-z_][A-Za-z0-9_-]*\}["']/m;
const GENERATED_SOURCE_CONTEXT_PATTERN =
  /```(?:python|py|javascript|js|typescript|ts|shell|bash|sh)\b|cat\s*(?:>|>>)?\s*[^`\n]*\.(?:py|js|ts|sh)\b|python3?\b|node\b/i;
const HARDCODED_CONNECTION_ID_PATTERN =
  /["']connection_id["']\s*:\s*["'][0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}["']/i;
const GOOGLE_SHEETS_SPREADSHEET_URL_PATTERN =
  /https?:\/\/[^\s"'`]*\/spreadsheets\/([A-Za-z0-9_-]{20,})\/[^\s"'`]*/i;
const DESTRUCTIVE_DELETE_PATTERN =
  /\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(["']?)(\/root\/\.openclaw\/|\/home\/[^/\s"'`]+\/\.openclaw\/|\/Users\/[^/\s"'`]+\/\.openclaw\/|~\/\.openclaw\/|\$HOME\/\.openclaw\/|\$\{HOME\}\/\.openclaw\/|\/etc\/|\/usr\/|\/opt\/|\/Library\/|\/Applications\/)[^\s"'`;|&)]*\1/i;
const SHELL_POSITIONAL_ASSIGNMENT_PATTERN =
  /^\s*([A-Z_][A-Z0-9_]*)=(["']?)\$(?:[1-9][0-9]*|@|\*)\2\s*(?:#.*)?$/gm;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:[A-Za-z0-9]+[_\s-]+)*(?:(?:api|client|consumer)[_\s-]?(?:secret|key|token)|secret[_\s-]?key|access[_\s-]?(?:token|key|secret|grant)|auth[_\s-]?token|bearer(?:[_\s-]?token)?|private[_\s-]?key|service[_\s-]?role[_\s-]?key|github[_\s-]?(?:pat|token)|(?:openrouter|supabase|storj)[_\s-]?(?:key|token|secret|access[_\s-]?grant)|password)\b\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})["'`]?/i;
const AUTH_HEADER_SECRET_PATTERN =
  /\b(?:authorization|x-api-key|x-api-secret)\b\s*[:=]\s*(?:Bearer\s+)?["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})["'`]?/i;
const SHELL_CREDENTIAL_VARIABLE_PATTERN =
  /\$(?:\{)?[A-Z_][A-Z0-9_]*(?:TOKEN|PAT|SECRET|KEY)[A-Z0-9_]*(?:\})?/;
const GIT_REMOTE_CREDENTIAL_URL_PATTERN =
  /\bgit\s+remote\s+set-url\b[^\n]*https?:\/\/[^\s"'`]*\$(?:\{)?[A-Z_][A-Z0-9_]*(?:TOKEN|PAT|SECRET|KEY)[A-Z0-9_]*(?:\})?[^\s"'`]*@/i;
const MEMORY_CREDENTIAL_STORAGE_PATTERN =
  /\bsave\s+(?:it|the\s+(?:token|secret|credential|key|pat))\s+to\s+(?:your\s+)?(?:memory|conversation|chat)\b/i;
const HOST_PLATFORM_SOURCE_CONTEXT_PATTERN =
  /\$[{]?OPENCLAW_DIR[}]?.{0,200}\/src\/|\/src\/agents\/|\/src\/tools\//is;
const HOST_PLATFORM_PATCH_COMMAND_PATTERN =
  /\b(?:sed\s+-i|perl\s+-0?pi|cp\s+|cat\s+>|python3?\b.{0,120}(?:write|replace))/i;
const HOST_PLATFORM_REBUILD_PATTERN = /\b(?:pnpm\s+build|npm\s+run\s+build|bun\s+run\s+build)\b/i;
const BROWSER_USE_PASSWORD_ARGV_PATTERN =
  /\bbrowser-use\s+input\b[^\n]*(?:password|passwd|\$[A-Z_]*(?:PASSWORD|PASS|PWD)[A-Z0-9_]*|<password>|\{password\})/i;
const BROWSER_USE_AUTH_EVAL_PATTERN = /\bbrowser-use\s+(?:eval|python)\b/i;
const AUTHENTICATED_MAIL_CONTEXT_PATTERN = /\b(?:mail\.google\.com|gmail|webmail|mailbox|inbox)\b/i;
const PERSISTENCE_SCHEDULER_PATTERN =
  /\b(?:launchctl\s+load|crontab\b|LaunchAgents\/|systemctl\s+(?:--user\s+)?enable)\b/i;
const SECRET_ARGV_WARNING_PATTERN =
  /\b(?:do\s+not|don't|avoid|never|reject)\b[^\n]{0,120}\b(?:argv|argument|from-mnemonic|private[-_\s]?key|seed[-\s]?phrase|mnemonic)\b/i;
const FROM_MNEMONIC_ARGV_PATTERN =
  /\b(?:npx|bunx|pnpm\s+dlx|npm\s+exec|node|python3?|uvx)\b[^\n]{0,200}\bfrom-mnemonic\b[^\n]{0,200}(?:"[^"\n]{8,}"|'[^'\n]{8,}'|<[^>\n]{6,}>|\$[A-Z_][A-Z0-9_]*(?:MNEMONIC|SEED|PHRASE)[A-Z0-9_]*)/i;
const SECRET_FLAG_ARGV_PATTERN =
  /\b(?:npx|bunx|pnpm\s+dlx|npm\s+exec|node|python3?|uvx|docker\s+run)\b[^\n]{0,240}--(?:private-key|seed|seed-phrase|mnemonic|password|token)\s+(?:"[^"\n]{8,}"|'[^'\n]{8,}'|<[^>\n]{4,}>|\$[A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|MNEMONIC|SEED|PHRASE)[A-Z0-9_]*)/i;
const SECRET_ARGV_REDACTION_PATTERN =
  /(\b(?:from-mnemonic|--(?:private-key|seed|seed-phrase|mnemonic|password|token))\s+)(["'`])([^"'`]{8,})\2/gi;
const DYNAMIC_CODE_EXECUTION_PATTERN =
  /\beval\s*\(|new\s+Function\s*\(|\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?loader\.exec_module\s*\(/;
const SHELL_BASE64_FILE_READ_PATTERN =
  /(?:\bcat\s+["']?\$[A-Za-z_][A-Za-z0-9_]*["']?\s*\|\s*base64\b|\bbase64\b[^\n]{0,80}["']?\$[A-Za-z_][A-Za-z0-9_]*["']?)/i;
const SHELL_NETWORK_UPLOAD_PATTERN =
  /\bcurl\b[\s\S]{0,1600}(?:--data(?:-binary|-raw)?\b|-d\b|--form\b|-F\b|--upload-file\b|Authorization\s*:)/i;
const PYTHON_BASE64_FILE_READ_PATTERN =
  /base64\.b64encode\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*\.read_bytes\s*\(\s*\)|Path\s*\([^)]*\)\.read_bytes\s*\(\s*\)|open\s*\([^)]*["']rb["'][\s\S]{0,120}\.read\s*\(\s*\))/i;
const PYTHON_NETWORK_UPLOAD_PATTERN =
  /\b(?:requests|session|self\.session|client|httpx\.(?:post|request))\.post\s*\([\s\S]{0,1600}(?:json\s*=|data\s*=|files\s*=|headers\s*=|Authorization)/i;
const PLAYWRIGHT_CHROMIUM_PATTERN = /\b(?:playwright\.)?chromium\.launch\s*\(/i;
const FILE_URL_BROWSER_NAVIGATION_PATTERN = /\bpage\.goto\s*\([^)]*file:\/\//i;
const SVG_HTML_INTERPOLATION_PATTERN =
  /(?:<body>[\s\S]{0,240}\$\{[^}]*svg[^}]*\}|writeFile(?:Sync)?\s*\([^)]*\.html[^)]*\$\{[^}]*svg[^}]*\}|\$\{[^}]*svg[^}]*\}[\s\S]{0,240}<\/body>)/i;
const BROWSER_JS_DISABLED_PATTERN =
  /javaScriptEnabled\s*:\s*false|Content-Security-Policy|script-src\s+['"]?none/i;
const AGENT_OUTPUT_DIR_ARGUMENT_PATTERN =
  /add_argument\s*\(\s*["']--outdir["']|args\.outdir|output_path\s*=\s*Path\s*\(\s*args\.outdir\s*\)/i;
const FFMPEG_FORCE_OUTPUT_PATTERN =
  /subprocess\.run\s*\(\s*\[[\s\S]{0,1000}["']ffmpeg["'][\s\S]{0,1000}["']-y["'][\s\S]{0,1000}str\s*\(\s*output_path\s*\)/i;
const OUTPUT_PATH_GUARD_PATTERN =
  /TemporaryDirectory|mkdtemp|tempfile\.|resolve\s*\(\s*\).*relative_to|is_relative_to\s*\(/i;
const INSECURE_TLS_VERIFICATION_PATTERN =
  /ssl\._create_unverified_context\s*\(|ssl\.CERT_NONE\b|check_hostname\s*=\s*False\b|verify\s*=\s*False\b|rejectUnauthorized\s*:\s*false\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0["']?/i;
const PYTHON_AGENT_FILENAME_PATTERN =
  /\b(?:filename\s*:\s*str|req\.filename|filename\s*=|["']filename["'])\b/i;
const PYTHON_RCLONE_FILENAME_SINK_PATTERN =
  /(?:rclone_dir\s*\/\s*filename|f["']\.\/\{filename\}|open\s*\(\s*temp_file_path\s*,|subprocess\.run\s*\([\s\S]{0,1000}["']\.\/rclone["'])/i;
const PYTHON_FILENAME_GUARD_PATTERN =
  /\b(?:secure_filename|basename\s*\(|Path\s*\(\s*filename\s*\)\.name|filename\s*=\s*Path\s*\(\s*filename\s*\)\.name|resolve\s*\(\s*\).*relative_to|is_relative_to\s*\(|["']\.\.["']\s+in\s+filename|["']\/["']\s+in\s+filename)/i;
const PYTHON_CREDENTIAL_ENV_PATTERN =
  /\b(?:os\.environ(?:\.get)?|os\.getenv|getenv)\s*(?:\[\s*|\(\s*)["'][A-Za-z_][A-Za-z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY)[A-Za-z0-9_]*["']/i;
const PYTHON_URL_ENV_PATTERN =
  /\b(?:os\.environ(?:\.get)?|os\.getenv|getenv)\s*(?:\[\s*|\(\s*)["'][A-Za-z_][A-Za-z0-9_]*(?:BASE_URL|URL|HOST|ENDPOINT)[A-Za-z0-9_]*["']/i;
const PYTHON_HTTP_POST_PATTERN =
  /\b(?:requests|session|self\.session|client)\.post\s*\(|\.post\s*\(/i;
const PASSWORD_PAYLOAD_PATTERN = /["']password["']\s*:|password\s*=/i;
const AUTONOMOUS_AGENT_SCHEDULE_PATTERN =
  /\bAUTO_ANSWER\s*=\s*(?:true|os\.getenv\s*\(\s*["']AUTO_ANSWER["']\s*,\s*["']true["'])|while\s+True\s*:|time\.sleep\s*\(\s*(?:[3-9]\d{2,}|[1-9]\d{3,})\s*\)|\binterval\s*=\s*(?:[3-9]\d{2,}|[1-9]\d{3,})|"kind"\s*:\s*"cron"|"expr"\s*:\s*["'][^"']*\*\/(?:[1-5]?\d)\b/is;
const CREDENTIAL_BEARING_AGENT_PATTERN =
  /\b(?:X-API-Key|api_key|API_KEY|VDOOB_API_KEY|AGENT_ID|agent_config\.json)\b/i;
const AUTONOMOUS_ANSWER_EGRESS_PATTERN =
  /\b(?:requests|session|client)\.post\s*\([\s\S]{0,1000}(?:submit-answer|agent-withdrawals|agents\/register|messages\/agent)|\b(?:submit_answer|answer_question|act_cron_check)\b/i;
const HARDCODED_OPERATOR_BASE_URL_PATTERN =
  /\bBASE_URL\s*=\s*["']https:\/\/(?!your-|example\.|localhost\b|127\.0\.0\.1\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:\/[^"']*)?["']/i;
const OAUTH_CLIENT_SECRET_FLOW_PATTERN =
  /\b(?:oauth\/register|oauth\/token|client_secret|Authorization:\s*Bearer|ACCESS_TOKEN)\b/i;
const LIGHTNING_BILLING_FLOW_PATTERN =
  /\b(?:billing\/agent\/(?:create|check)-invoice|amount_sats|LNURL|Lightning|PAYG)\b/i;
const OUTBOUND_POST_PATTERN = /\b(?:curl\s+-X\s+POST|requests\.post\s*\(|fetch\s*\()/i;
const REMOTE_RECIPE_FETCH_PATTERN =
  /\b(?:curl|requests\.get|fetch)\b[\s\S]{0,600}(?:error-codes\.json|recipes?\.json|patterns\.json|docs\.openclaw\.ai)|ERROR_CODES_URL\s*=/i;
const MUTABLE_RECIPE_STORE_PATTERN =
  /\b(?:error-patterns\.json|recipes?\.json|safe_auto|fix_recipe_id|["']command["'])\b/i;
const TEMPLATED_SUBPROCESS_EXECUTION_PATTERN =
  /\bsubstitute_params\s*\([\s\S]{0,500}\b(?:shlex\.split|subprocess\.run)\b|\b(?:shlex\.split|subprocess\.run)\b[\s\S]{0,500}\bsubstitute_params\s*\(/i;
const CONFIRMATION_BYPASS_TRIGGER_PATTERN =
  /\b(?:OPENCLAW_AGENT_CALL|SAFE_EXEC_AUTO_CONFIRM|SAFEXEC_CONTEXT|I understand the risk)\b/i;
const RISK_CONFIRMATION_CONTEXT_PATTERN =
  /\b(?:critical|high|medium|risk|approval|approve|confirm|confirmation|read\s+-p)\b/i;
const DIRECT_COMMAND_EVAL_PATTERN = /\beval\s+["']?\$command\b/i;
const HIGH_RISK_CONTEXT_EVAL_PATTERN =
  /\b(?:critical|high|medium)\b[\s\S]{0,900}\beval\s+["']?\$command\b|\bI understand the risk\b[\s\S]{0,1200}\beval\s+["']?\$command\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
function truncateEvidence(s, maxLen = 160) {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...`;
}

function looksLikePlaceholderIdentifier(id) {
  return /^[A-Z0-9_]+$/.test(id) || /(your|example|placeholder)/i.test(id);
}

function looksLikePlaceholderSecret(secret) {
  const n = secret.trim().toLowerCase();
  if (!n) return true;
  if (/^(?:x+|_+|-+|\*+|\.{3})$/.test(n)) return true;
  if (/process\.env\.|os\.environ[.[]|getenv\s*\(/.test(n)) return true;
  return /(your|example|placeholder|change-?me|replace|redacted|dummy|sample|test-token|token-here|secret-here|api-key-here)/i.test(
    n
  );
}

function findFirstLine(content, pattern) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) {
      return { line: i + 1, text: lines[i] };
    }
  }
  return { line: 1, text: lines[0] ?? '' };
}

function findLineAtIndex(content, index) {
  const line = content.slice(0, index).split('\n').length;
  const lineStart = content.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const next = content.indexOf('\n', index);
  const lineEnd = next === -1 ? content.length : next;
  return { line, text: content.slice(lineStart, lineEnd) };
}

function findCallEnd(content, openParenIndex) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let i = openParenIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return content.length;
}

function isSafeLiteralExecFileCall(callText) {
  const m = callText.match(/\b(execFile|execFileSync)\s*\(\s*(["'])([^"']+)\2\s*,\s*\[/);
  if (!m) return false;
  if (/\bshell\s*:\s*true\b/.test(callText)) return false;
  const exe = m[3]?.trim().toLowerCase();
  if (!exe) return false;
  const base = exe.split(/[\\/]/).at(-1) ?? exe;
  return !/^(?:sh|bash|zsh|fish|cmd|powershell|pwsh)$/.test(base);
}

function findDangerousChildProcessCall(content) {
  if (!/child_process/.test(content)) return null;
  const execPattern = /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/g;
  for (const m of content.matchAll(execPattern)) {
    const name = m[1];
    const idx = m.index;
    if (idx === undefined || !name) continue;
    if (name === 'execFile' || name === 'execFileSync') {
      const op = content.indexOf('(', idx);
      const end = findCallEnd(content, op);
      const callText = content.slice(idx, end);
      if (isSafeLiteralExecFileCall(callText)) continue;
    }
    return findLineAtIndex(content, idx);
  }
  return null;
}

function findHardcodedSecret(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(SECRET_ASSIGNMENT_PATTERN) ?? line.match(AUTH_HEADER_SECRET_PATTERN);
    const secret = m?.[1];
    if (!secret || looksLikePlaceholderSecret(secret)) continue;
    return { line: i + 1, text: line.replaceAll(secret, '[REDACTED]') };
  }
  return null;
}

function hasNearbyConfirmationGate(lines, commandIndex) {
  const start = Math.max(0, commandIndex - 8);
  const ctx = lines.slice(start, commandIndex + 1).join('\n');
  return [
    /\bask\s+(?:the\s+)?user\b.{0,120}\b(?:confirm|confirmation|approve|approval|continue|yes)\b/is,
    /\b(?:prompt\s+for|require|request|obtain)\s+(?:explicit\s+)?(?:user\s+)?(?:confirmation|approval)\b/is,
    /\buser\s+(?:confirmation|approval)\b/is,
    /\bcontinue\?\s*\(?(?:yes\/no|y\/n)\)?/is,
    /\breply\s+["']?yes["']?\b/is,
    /\bonly\s+(?:continue\s+)?after\s+(?:the\s+)?user\b.{0,80}\b(?:confirms?|approves?|answers?\s+yes)\b/is,
  ].some((p) => p.test(ctx));
}

function findUnguardedDestructiveDelete(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!DESTRUCTIVE_DELETE_PATTERN.test(lines[i])) continue;
    if (hasNearbyConfirmationGate(lines, i)) continue;
    return { line: i + 1, text: lines[i] };
  }
  return null;
}

function findCredentialExposureInstruction(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (
      GIT_REMOTE_CREDENTIAL_URL_PATTERN.test(line) ||
      (MEMORY_CREDENTIAL_STORAGE_PATTERN.test(line) &&
        SHELL_CREDENTIAL_VARIABLE_PATTERN.test(content))
    ) {
      return { line: i + 1, text: line };
    }
  }
  return null;
}

function findBrowserCredentialAutomation(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (BROWSER_USE_PASSWORD_ARGV_PATTERN.test(lines[i] ?? ''))
      return { line: i + 1, text: lines[i] };
  }
  if (
    BROWSER_USE_AUTH_EVAL_PATTERN.test(content) &&
    AUTHENTICATED_MAIL_CONTEXT_PATTERN.test(content) &&
    PERSISTENCE_SCHEDULER_PATTERN.test(content)
  ) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (BROWSER_USE_AUTH_EVAL_PATTERN.test(line) || PERSISTENCE_SCHEDULER_PATTERN.test(line)) {
        return { line: i + 1, text: line };
      }
    }
  }
  return null;
}

function redactSecretArgvEvidence(line) {
  return line.replace(SECRET_ARGV_REDACTION_PATTERN, '$1$2[REDACTED]$2');
}

function findSecretArgvExposure(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (SECRET_ARGV_WARNING_PATTERN.test(line)) continue;
    if (FROM_MNEMONIC_ARGV_PATTERN.test(line) || SECRET_FLAG_ARGV_PATTERN.test(line)) {
      return { line: i + 1, text: redactSecretArgvEvidence(line) };
    }
  }
  return null;
}

function findHostPlatformSourcePatch(content) {
  if (!HOST_PLATFORM_SOURCE_CONTEXT_PATTERN.test(content)) return null;
  if (!HOST_PLATFORM_REBUILD_PATTERN.test(content)) return null;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!HOST_PLATFORM_PATCH_COMMAND_PATTERN.test(line)) continue;
    if (hasNearbyConfirmationGate(lines, i)) continue;
    return { line: i + 1, text: line };
  }
  return null;
}

function hasShellVariableValidation(content, variable, useIndex) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const beforeUse = content.slice(0, useIndex);
  const variableReference = `(?:\\$\\{${escaped}\\}|\\$${escaped})`;
  const lengthCheck = new RegExp(
    `\\$\\{#${escaped}\\}\\s*(?:-[a-z]\\s+)?(?:[<>!=]=?|-[gl][te])`,
    'm'
  );
  const controlCharStrip = new RegExp(
    `(?:tr\\s+-d\\s+["']?\\\\(?:000|x00).{0,80}\\\\(?:037|x1[fF]|177|x7[fF])|${escaped}\\s*=.*tr\\s+-d)`,
    's'
  );
  const explicitValidation = new RegExp(
    `(?:validate|sanitize|strip|clean)[A-Za-z0-9_ -]{0,60}${variableReference}|${variableReference}.{0,60}(?:validate|sanitize|strip|clean)`,
    'is'
  );
  return (
    lengthCheck.test(beforeUse) ||
    controlCharStrip.test(beforeUse) ||
    explicitValidation.test(beforeUse)
  );
}

function findUnsafeBrowserTextInput(content) {
  for (const a of content.matchAll(SHELL_POSITIONAL_ASSIGNMENT_PATTERN)) {
    const v = a[1];
    if (!v) continue;
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const browserTextPattern = new RegExp(
      `\\bbrowser\\s+action=act\\b[^\\n]*\\bkind=["']?type["']?[^\\n]*\\btext=(?:"\\$${escaped}"|'\\$${escaped}'|\\$${escaped})(?![A-Za-z0-9_])`,
      'i'
    );
    const m = content.match(browserTextPattern);
    if (!m || m.index === undefined) continue;
    if (hasShellVariableValidation(content, v, m.index)) continue;
    return findLineAtIndex(content, m.index);
  }
  return null;
}

function findShellBase64FileUpload(content) {
  if (!/\bcurl\b/i.test(content) || !/\bbase64\b/i.test(content)) return null;
  if (!SHELL_NETWORK_UPLOAD_PATTERN.test(content)) return null;
  return findFirstLine(content, SHELL_BASE64_FILE_READ_PATTERN);
}

function findPythonBase64FileUpload(content) {
  if (!/base64\.b64encode/i.test(content)) return null;
  if (!PYTHON_NETWORK_UPLOAD_PATTERN.test(content)) return null;
  return findFirstLine(content, PYTHON_BASE64_FILE_READ_PATTERN);
}

function findUnsafeBrowserFileRender(content) {
  if (!PLAYWRIGHT_CHROMIUM_PATTERN.test(content)) return null;
  if (!FILE_URL_BROWSER_NAVIGATION_PATTERN.test(content)) return null;
  if (!SVG_HTML_INTERPOLATION_PATTERN.test(content)) return null;
  if (BROWSER_JS_DISABLED_PATTERN.test(content)) return null;
  return findFirstLine(content, FILE_URL_BROWSER_NAVIGATION_PATTERN);
}

function findUnsafeAgentControlledFileWrite(content) {
  if (!AGENT_OUTPUT_DIR_ARGUMENT_PATTERN.test(content)) return null;
  if (!FFMPEG_FORCE_OUTPUT_PATTERN.test(content)) return null;
  if (OUTPUT_PATH_GUARD_PATTERN.test(content)) return null;
  return findFirstLine(content, /subprocess\.run\s*\(|["']-y["']|output_path\s*=/);
}

function findUnsafePythonRcloneFilename(content) {
  if (!PYTHON_AGENT_FILENAME_PATTERN.test(content)) return null;
  if (!/\brclone\b/.test(content) || !/subprocess\.run\s*\(/.test(content)) return null;
  if (!PYTHON_RCLONE_FILENAME_SINK_PATTERN.test(content)) return null;
  if (PYTHON_FILENAME_GUARD_PATTERN.test(content)) return null;
  return findFirstLine(
    content,
    /rclone_dir\s*\/\s*filename|f["']\.\/\{filename\}|subprocess\.run\s*\(/
  );
}

function findPythonCredentialPostToEnvUrl(content) {
  if (!PYTHON_CREDENTIAL_ENV_PATTERN.test(content)) return null;
  if (!PYTHON_URL_ENV_PATTERN.test(content)) return null;
  if (!PYTHON_HTTP_POST_PATTERN.test(content)) return null;
  if (!PASSWORD_PAYLOAD_PATTERN.test(content)) return null;
  return findFirstLine(content, PYTHON_HTTP_POST_PATTERN);
}

function findAutonomousCredentialEgress(files) {
  const all = files.map((f) => f.content).join('\n');
  if (!AUTONOMOUS_AGENT_SCHEDULE_PATTERN.test(all)) return null;
  if (!CREDENTIAL_BEARING_AGENT_PATTERN.test(all)) return null;
  if (!AUTONOMOUS_ANSWER_EGRESS_PATTERN.test(all)) return null;
  for (const f of files) {
    if (!AUTONOMOUS_ANSWER_EGRESS_PATTERN.test(f.content)) continue;
    const m = findFirstLine(f.content, AUTONOMOUS_ANSWER_EGRESS_PATTERN);
    return { file: f.path, line: m.line, text: m.text };
  }
  const fallback = files[0];
  if (!fallback) return null;
  return { file: fallback.path, line: 1, text: fallback.content.split('\n')[0] ?? '' };
}

function findRemoteRecipeExecution(files) {
  const all = files.map((f) => f.content).join('\n');
  if (!REMOTE_RECIPE_FETCH_PATTERN.test(all)) return null;
  if (!MUTABLE_RECIPE_STORE_PATTERN.test(all)) return null;
  if (!TEMPLATED_SUBPROCESS_EXECUTION_PATTERN.test(all)) return null;
  for (const f of files) {
    if (!TEMPLATED_SUBPROCESS_EXECUTION_PATTERN.test(f.content)) continue;
    const m = findFirstLine(f.content, /substitute_params\s*\(|shlex\.split|subprocess\.run/);
    return { file: f.path, line: m.line, text: m.text };
  }
  const fallback = files[0];
  if (!fallback) return null;
  return { file: fallback.path, line: 1, text: fallback.content.split('\n')[0] ?? '' };
}

function findHardcodedOperatorBillingEndpoint(content) {
  if (!HARDCODED_OPERATOR_BASE_URL_PATTERN.test(content)) return null;
  if (!OAUTH_CLIENT_SECRET_FLOW_PATTERN.test(content)) return null;
  if (!LIGHTNING_BILLING_FLOW_PATTERN.test(content)) return null;
  if (!OUTBOUND_POST_PATTERN.test(content)) return null;
  return findFirstLine(content, HARDCODED_OPERATOR_BASE_URL_PATTERN);
}

function findConfirmationBypass(content) {
  if (!CONFIRMATION_BYPASS_TRIGGER_PATTERN.test(content)) return null;
  if (!RISK_CONFIRMATION_CONTEXT_PATTERN.test(content)) return null;
  if (!DIRECT_COMMAND_EVAL_PATTERN.test(content)) return null;
  if (!HIGH_RISK_CONTEXT_EVAL_PATTERN.test(content)) return null;
  return findFirstLine(
    content,
    /SAFEXEC_CONTEXT|I understand the risk|OPENCLAW_AGENT_CALL|SAFE_EXEC_AUTO_CONFIRM|eval\s+["']?\$command/
  );
}

function hasMaliciousInstallPrompt(content) {
  const hasTerminalInstruction =
    /(?:copy|paste).{0,80}(?:command|snippet).{0,120}(?:terminal|shell)/is.test(content) ||
    /run\s+it\s+in\s+terminal/i.test(content) ||
    /open\s+terminal/i.test(content) ||
    /for\s+macos\s*:/i.test(content);
  if (!hasTerminalInstruction) return false;
  const hasCurlPipe = /(?:curl|wget)\b[^\n|]{0,240}\|\s*(?:\/bin\/)?(?:ba)?sh\b/i.test(content);
  const hasBase64Exec =
    /(?:echo|printf)\s+["'][A-Za-z0-9+/=\s]{40,}["']\s*\|\s*base64\s+-?[dD]\b[^\n|]{0,120}\|\s*(?:\/bin\/)?(?:ba)?sh\b/i.test(
      content
    );
  const hasRawIpUrl = RAW_IP_URL_PATTERN.test(content);
  const hasInstallerPackage = INSTALL_PACKAGE_PATTERN.test(content);
  return hasBase64Exec || (hasCurlPipe && (hasRawIpUrl || hasInstallerPackage));
}

// ─────────────────────────────────────────────────────────────────────────────
// declared env names from manifest/frontmatter
// ─────────────────────────────────────────────────────────────────────────────
function normalizeEnvName(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.toUpperCase() : undefined;
}
function addDeclaredEnvName(s, v) {
  const n = normalizeEnvName(v);
  if (n) s.add(n);
}
function addDeclaredEnvNamesFromList(s, v) {
  if (!Array.isArray(v)) return;
  for (const e of v) {
    if (typeof e === 'string') {
      addDeclaredEnvName(s, e);
      continue;
    }
    if (e && typeof e === 'object' && !Array.isArray(e)) addDeclaredEnvName(s, e.name);
  }
}
function addDeclaredEnvNamesFromRecord(s, r) {
  const req =
    r.requires && typeof r.requires === 'object' && !Array.isArray(r.requires)
      ? r.requires
      : undefined;
  addDeclaredEnvName(s, r.primaryEnv);
  addDeclaredEnvNamesFromList(s, r.envVars);
  addDeclaredEnvNamesFromList(s, r.env);
  addDeclaredEnvNamesFromList(s, req?.env);
}
function addDeclaredEnvNamesFromManifestBlock(s, v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return;
  addDeclaredEnvNamesFromRecord(s, v);
}
function collectDeclaredEnvNames(input) {
  const names = new Set();
  const sources = [input.frontmatter, input.metadata];
  for (const src of sources) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    addDeclaredEnvNamesFromRecord(names, src);
    addDeclaredEnvNamesFromManifestBlock(names, src.openclaw);
    addDeclaredEnvNamesFromManifestBlock(names, src.clawdis);
    addDeclaredEnvNamesFromManifestBlock(names, src.clawdbot);
    if (src.metadata && typeof src.metadata === 'object' && !Array.isArray(src.metadata)) {
      addDeclaredEnvNamesFromManifestBlock(names, src.metadata.openclaw);
      addDeclaredEnvNamesFromManifestBlock(names, src.metadata.clawdis);
      addDeclaredEnvNamesFromManifestBlock(names, src.metadata.clawdbot);
    }
  }
  return names;
}
function collectReferencedEnvNames(content) {
  const names = new Set();
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  ];
  for (const p of patterns) for (const m of content.matchAll(p)) addDeclaredEnvName(names, m[1]);
  return names;
}
function hasBroadEnvAccess(content) {
  return (
    /Object\.(?:keys|values|entries)\s*\(\s*process\.env\s*\)/.test(content) ||
    /process\.env(?!\s*(?:\.|\[))/.test(content) ||
    /process\.env\[\s*[^"'`\]]/.test(content)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// scanners
// ─────────────────────────────────────────────────────────────────────────────
function addFinding(findings, f) {
  findings.push({ ...f, evidence: truncateEvidence(f.evidence.trim()) });
}

function scanSecretLiteralFile(path, content, findings) {
  const m = findHardcodedSecret(content);
  if (!m) return;
  addFinding(findings, {
    code: REASON_CODES.EXPOSED_SECRET_LITERAL,
    severity: 'critical',
    file: path,
    line: m.line,
    message: 'File appears to expose a hardcoded API secret or token.',
    evidence: m.text,
  });
}

function scanPlaintextCgnatEndpointFile(path, content, findings) {
  if (!CGNAT_HTTP_URL_PATTERN.test(content)) return;
  const m = findFirstLine(content, CGNAT_HTTP_URL_PATTERN);
  addFinding(findings, {
    code: REASON_CODES.EXPOSED_RESOURCE_IDENTIFIER,
    severity: 'critical',
    file: path,
    line: m.line,
    message: 'Plaintext HTTP endpoint targets a CGNAT/Tailscale-range address.',
    evidence: m.text,
  });
}

function scanCodeFile(path, content, findings, declaredEnvNames) {
  if (!CODE_EXTENSION.test(path)) return;

  const dxp = findDangerousChildProcessCall(content);
  if (dxp) {
    addFinding(findings, {
      code: REASON_CODES.DANGEROUS_EXEC,
      severity: 'critical',
      file: path,
      line: dxp.line,
      message: 'Shell command execution detected (child_process).',
      evidence: dxp.text,
    });
  }

  if (DYNAMIC_CODE_EXECUTION_PATTERN.test(content)) {
    const m = findFirstLine(content, DYNAMIC_CODE_EXECUTION_PATTERN);
    addFinding(findings, {
      code: REASON_CODES.DYNAMIC_CODE,
      severity: 'critical',
      file: path,
      line: m.line,
      message: 'Dynamic code execution detected.',
      evidence: m.text,
    });
  }

  const ub = findUnsafeBrowserTextInput(content);
  if (ub)
    addFinding(findings, {
      code: REASON_CODES.UNSAFE_BROWSER_TEXT_INPUT,
      severity: 'warn',
      file: path,
      line: ub.line,
      message: 'Shell positional input is typed into browser automation without validation.',
      evidence: ub.text,
    });

  const hps = findHostPlatformSourcePatch(content);
  if (hps)
    addFinding(findings, {
      code: REASON_CODES.HOST_PLATFORM_SOURCE_PATCH,
      severity: 'critical',
      file: path,
      line: hps.line,
      message: 'Install code patches host platform source and rebuilds without confirmation.',
      evidence: hps.text,
    });

  const ubfr = findUnsafeBrowserFileRender(content);
  if (ubfr)
    addFinding(findings, {
      code: REASON_CODES.BROWSER_FILE_RENDER,
      severity: 'critical',
      file: path,
      line: ubfr.line,
      message:
        'Browser automation renders interpolated SVG/HTML from a file URL with JavaScript enabled.',
      evidence: ubfr.text,
    });

  const uafw = findUnsafeAgentControlledFileWrite(content);
  if (uafw)
    addFinding(findings, {
      code: REASON_CODES.UNSAFE_FILE_WRITE,
      severity: 'critical',
      file: path,
      line: uafw.line,
      message: 'Agent-controlled output path is passed to an overwrite-capable subprocess.',
      evidence: uafw.text,
    });

  if (INSECURE_TLS_VERIFICATION_PATTERN.test(content)) {
    const m = findFirstLine(content, INSECURE_TLS_VERIFICATION_PATTERN);
    addFinding(findings, {
      code: REASON_CODES.INSECURE_TLS_VERIFICATION,
      severity: 'warn',
      file: path,
      line: m.line,
      message: 'HTTPS certificate verification is disabled.',
      evidence: m.text,
    });
  }

  const uprf = findUnsafePythonRcloneFilename(content);
  if (uprf)
    addFinding(findings, {
      code: REASON_CODES.UNSAFE_FILE_WRITE,
      severity: 'critical',
      file: path,
      line: uprf.line,
      message: 'Agent-controlled filename is written and passed to rclone without path validation.',
      evidence: uprf.text,
    });

  const cb = findConfirmationBypass(content);
  if (cb)
    addFinding(findings, {
      code: REASON_CODES.CONFIRMATION_BYPASS,
      severity: 'critical',
      file: path,
      line: cb.line,
      message: 'Risky command approval can be bypassed through environment or context signals.',
      evidence: cb.text,
    });

  if (/stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i.test(content)) {
    const m = findFirstLine(content, /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i);
    addFinding(findings, {
      code: REASON_CODES.CRYPTO_MINING,
      severity: 'critical',
      file: path,
      line: m.line,
      message: 'Possible crypto mining behavior detected.',
      evidence: m.text,
    });
  }

  const wsm = content.match(/new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/);
  if (wsm) {
    const port = Number.parseInt(wsm[1] ?? '', 10);
    if (Number.isFinite(port) && !STANDARD_PORTS.has(port)) {
      const m = findFirstLine(content, /new\s+WebSocket\s*\(/);
      addFinding(findings, {
        code: REASON_CODES.SUSPICIOUS_NETWORK,
        severity: 'warn',
        file: path,
        line: m.line,
        message: 'WebSocket connection to non-standard port detected.',
        evidence: m.text,
      });
    }
  }

  const hasFileRead = /readFileSync|readFile/.test(content);
  const hasNetworkSend = /\bfetch\b|http\.request|\baxios\b/.test(content);
  if (hasFileRead && hasNetworkSend) {
    const m = findFirstLine(content, /readFileSync|readFile/);
    addFinding(findings, {
      code: REASON_CODES.EXFILTRATION,
      severity: 'warn',
      file: path,
      line: m.line,
      message: 'File read combined with network send (possible exfiltration).',
      evidence: m.text,
    });
  }

  const sb64 = findShellBase64FileUpload(content);
  if (sb64)
    addFinding(findings, {
      code: REASON_CODES.EXFILTRATION,
      severity: 'critical',
      file: path,
      line: sb64.line,
      message: 'Shell script base64-encodes a local file and sends it over the network.',
      evidence: sb64.text,
    });

  const pb64 = findPythonBase64FileUpload(content);
  if (pb64)
    addFinding(findings, {
      code: REASON_CODES.EXFILTRATION,
      severity: 'critical',
      file: path,
      line: pb64.line,
      message: 'Python code base64-encodes a local file and sends it over the network.',
      evidence: pb64.text,
    });

  const pcp = findPythonCredentialPostToEnvUrl(content);
  if (pcp)
    addFinding(findings, {
      code: REASON_CODES.CREDENTIAL_HARVEST,
      severity: 'critical',
      file: path,
      line: pcp.line,
      message:
        'Python code POSTs credential environment variables to an environment-controlled URL.',
      evidence: pcp.text,
    });

  const hob = findHardcodedOperatorBillingEndpoint(content);
  if (hob)
    addFinding(findings, {
      code: REASON_CODES.HARDCODED_OPERATOR_BILLING,
      severity: 'critical',
      file: path,
      line: hob.line,
      message:
        'Hardcoded operator endpoint combines OAuth credentials with Lightning billing calls.',
      evidence: hob.text,
    });

  const hasProcessEnv = /process\.env/.test(content);
  if (hasProcessEnv && hasNetworkSend) {
    const ref = collectReferencedEnvNames(content);
    const onlyDeclared =
      ref.size > 0 && [...ref].every((n) => declaredEnvNames.has(n)) && !hasBroadEnvAccess(content);
    if (!onlyDeclared) {
      const m = findFirstLine(content, /process\.env/);
      addFinding(findings, {
        code: REASON_CODES.CREDENTIAL_HARVEST,
        severity: 'critical',
        file: path,
        line: m.line,
        message: 'Environment variable access combined with network send.',
        evidence: m.text,
      });
    }
  }

  if (
    /(\\x[0-9a-fA-F]{2}){6,}/.test(content) ||
    /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/.test(content)
  ) {
    const m = findFirstLine(content, /(\\x[0-9a-fA-F]{2}){6,}|(?:atob|Buffer\.from)\s*\(/);
    addFinding(findings, {
      code: REASON_CODES.OBFUSCATED_CODE,
      severity: 'warn',
      file: path,
      line: m.line,
      message: 'Potential obfuscated payload detected.',
      evidence: m.text,
    });
  }
}

function scanMarkdownFile(path, content, findings) {
  if (!MARKDOWN_EXTENSION.test(path)) return;

  const ce = findCredentialExposureInstruction(content);
  if (ce)
    addFinding(findings, {
      code: REASON_CODES.CREDENTIAL_EXPOSURE_INSTRUCTIONS,
      severity: 'critical',
      file: path,
      line: ce.line,
      message: 'Instructions expose credentials through shell, git config, or agent memory.',
      evidence: ce.text,
    });

  const bca = findBrowserCredentialAutomation(content);
  if (bca)
    addFinding(findings, {
      code: REASON_CODES.BROWSER_CREDENTIAL_AUTOMATION,
      severity: 'critical',
      file: path,
      line: bca.line,
      message: 'Browser automation instructions expose credentials or persist authenticated eval.',
      evidence: bca.text,
    });

  const sa = findSecretArgvExposure(content);
  if (sa)
    addFinding(findings, {
      code: REASON_CODES.SECRET_ARGV_EXPOSURE,
      severity: 'critical',
      file: path,
      line: sa.line,
      message: 'Instructions pass high-value credentials through process argv.',
      evidence: sa.text,
    });

  const hob = findHardcodedOperatorBillingEndpoint(content);
  if (hob)
    addFinding(findings, {
      code: REASON_CODES.HARDCODED_OPERATOR_BILLING,
      severity: 'critical',
      file: path,
      line: hob.line,
      message:
        'Hardcoded operator endpoint combines OAuth credentials with Lightning billing calls.',
      evidence: hob.text,
    });

  if (hasMaliciousInstallPrompt(content)) {
    const m = findFirstLine(
      content,
      /installer-package\s*:|base64\s+-?[dD]|(?:curl|wget)\b|run\s+it\s+in\s+terminal/i
    );
    addFinding(findings, {
      code: REASON_CODES.MALICIOUS_INSTALL_PROMPT,
      severity: 'critical',
      file: path,
      line: m.line,
      message: 'Install prompt contains an obfuscated terminal payload.',
      evidence: m.text,
    });
  }

  const dd = findUnguardedDestructiveDelete(content);
  if (dd)
    addFinding(findings, {
      code: REASON_CODES.DESTRUCTIVE_DELETE_COMMAND,
      severity: 'warn',
      file: path,
      line: dd.line,
      message:
        'Documentation contains a destructive delete command without an explicit confirmation gate.',
      evidence: dd.text,
    });

  const ub = findUnsafeBrowserTextInput(content);
  if (ub)
    addFinding(findings, {
      code: REASON_CODES.UNSAFE_BROWSER_TEXT_INPUT,
      severity: 'warn',
      file: path,
      line: ub.line,
      message: 'Shell positional input is typed into browser automation without validation.',
      evidence: ub.text,
    });

  if (
    /ignore\s+(all\s+)?previous\s+instructions/i.test(content) ||
    /system\s*prompt\s*[:=]/i.test(content)
  ) {
    const m = findFirstLine(
      content,
      /ignore\s+(all\s+)?previous\s+instructions|system\s*prompt\s*[:=]/i
    );
    addFinding(findings, {
      code: REASON_CODES.INJECTION_INSTRUCTIONS,
      severity: 'warn',
      file: path,
      line: m.line,
      message: 'Prompt-injection style instruction pattern detected.',
      evidence: m.text,
    });
  }

  if (
    GENERATED_SOURCE_PLACEHOLDER_PATTERN.test(content) &&
    GENERATED_SOURCE_CONTEXT_PATTERN.test(content)
  ) {
    const m = findFirstLine(content, GENERATED_SOURCE_PLACEHOLDER_PATTERN);
    addFinding(findings, {
      code: REASON_CODES.GENERATED_SOURCE_TEMPLATE,
      severity: 'critical',
      file: path,
      line: m.line,
      message: 'User-controlled placeholder is embedded directly into generated source code.',
      evidence: m.text,
    });
  }

  if (HARDCODED_CONNECTION_ID_PATTERN.test(content)) {
    const m = findFirstLine(content, HARDCODED_CONNECTION_ID_PATTERN);
    addFinding(findings, {
      code: REASON_CODES.EXPOSED_RESOURCE_IDENTIFIER,
      severity: 'critical',
      file: path,
      line: m.line,
      message: 'Example code exposes a concrete connection_id instead of a placeholder.',
      evidence: m.text,
    });
  }

  const sp = new RegExp(
    GOOGLE_SHEETS_SPREADSHEET_URL_PATTERN.source,
    `${GOOGLE_SHEETS_SPREADSHEET_URL_PATTERN.flags.replaceAll('g', '')}g`
  );
  for (const m of content.matchAll(sp)) {
    const id = m[1];
    if (!id || looksLikePlaceholderIdentifier(id)) continue;
    const r = findLineAtIndex(content, m.index ?? 0);
    addFinding(findings, {
      code: REASON_CODES.EXPOSED_RESOURCE_IDENTIFIER,
      severity: 'critical',
      file: path,
      line: r.line,
      message:
        'Example code exposes a concrete Google Sheets spreadsheet ID instead of a placeholder.',
      evidence: r.text,
    });
    break;
  }
}

function scanManifestFile(path, content, findings) {
  if (!MANIFEST_EXTENSION.test(path)) return;
  if (
    /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\//i.test(content) ||
    RAW_IP_URL_PATTERN.test(content)
  ) {
    const m = findFirstLine(
      content,
      /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\/|https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i
    );
    addFinding(findings, {
      code: REASON_CODES.SUSPICIOUS_INSTALL_SOURCE,
      severity: 'warn',
      file: path,
      line: m.line,
      message: 'Install source points to URL shortener or raw IP.',
      evidence: m.text,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// driver
// ─────────────────────────────────────────────────────────────────────────────
function runStaticModerationScan(input) {
  const findings = [];
  const files = [...input.fileContents].sort((a, b) => a.path.localeCompare(b.path));
  const declaredEnvNames = collectDeclaredEnvNames(input);

  for (const f of files) {
    scanSecretLiteralFile(f.path, f.content, findings);
    scanPlaintextCgnatEndpointFile(f.path, f.content, findings);
    scanCodeFile(f.path, f.content, findings, declaredEnvNames);
    scanMarkdownFile(f.path, f.content, findings);
    scanManifestFile(f.path, f.content, findings);
  }

  const ace = findAutonomousCredentialEgress(files);
  if (ace)
    addFinding(findings, {
      code: REASON_CODES.AUTONOMOUS_CREDENTIAL_EGRESS,
      severity: 'critical',
      file: ace.file,
      line: ace.line,
      message:
        'Autonomous schedule or loop submits credential-bearing agent output without per-call consent.',
      evidence: ace.text,
    });

  const rre = findRemoteRecipeExecution(files);
  if (rre)
    addFinding(findings, {
      code: REASON_CODES.REMOTE_RECIPE_EXECUTION,
      severity: 'critical',
      file: rre.file,
      line: rre.line,
      message: 'Remote recipe/catalog data can influence templated subprocess command execution.',
      evidence: rre.text,
    });

  const installJson = JSON.stringify(input.metadata ?? {});
  if (/https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\//i.test(installJson)) {
    addFinding(findings, {
      code: REASON_CODES.SUSPICIOUS_INSTALL_SOURCE,
      severity: 'warn',
      file: 'metadata',
      line: 1,
      message: 'Install metadata references shortener URL.',
      evidence: installJson,
    });
  }

  const alwaysValue = input.frontmatter.always;
  if (alwaysValue === true || alwaysValue === 'true') {
    addFinding(findings, {
      code: REASON_CODES.MANIFEST_PRIVILEGED_ALWAYS,
      severity: 'warn',
      file: 'SKILL.md',
      line: 1,
      message: 'Skill is configured with always=true (persistent invocation).',
      evidence: 'always: true',
    });
  }

  const identityText = `${input.slug}\n${input.displayName}\n${input.summary ?? ''}`;
  if (/keepcold131\/ClawdAuthenticatorTool|ClawdAuthenticatorTool/i.test(identityText)) {
    addFinding(findings, {
      code: REASON_CODES.KNOWN_BLOCKED_SIGNATURE,
      severity: 'critical',
      file: 'metadata',
      line: 1,
      message: 'Matched a known blocked malware signature.',
      evidence: identityText,
    });
  }

  findings.sort((a, b) =>
    `${a.code}:${a.file}:${a.line}:${a.message}`.localeCompare(
      `${b.code}:${b.file}:${b.line}:${b.message}`
    )
  );
  const reasonCodes = normalizeReasonCodes(findings.map((f) => f.code));
  const status = verdictFromCodes(reasonCodes);
  return {
    status,
    reasonCodes,
    findings,
    summary: summarizeReasonCodes(reasonCodes),
    engineVersion: MODERATION_ENGINE_VERSION,
    checkedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// gather files this package would publish (from package.json `files`)
// ─────────────────────────────────────────────────────────────────────────────
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
}

function gatherPublishedFiles() {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  const entries = pkg.files ?? [];
  const all = [];
  // package.json itself is always published
  all.push(join(PKG_ROOT, 'package.json'));
  for (const entry of entries) {
    const target = resolve(PKG_ROOT, entry);
    if (!existsSync(target)) continue;
    const st = statSync(target);
    if (st.isDirectory()) walk(target, all);
    else if (st.isFile()) all.push(target);
  }
  return all;
}

function main() {
  const t0 = Date.now();
  const allFiles = gatherPublishedFiles();
  const fileContents = [];
  let skipped = 0;
  for (const abs of allFiles) {
    const rel = relative(PKG_ROOT, abs).replaceAll('\\', '/');
    if (!isTextFile(rel)) {
      skipped += 1;
      continue;
    }
    try {
      const content = readFileSync(abs, 'utf8');
      fileContents.push({ path: rel, content });
    } catch {
      skipped += 1;
    }
  }

  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  const pluginManifest = JSON.parse(readFileSync(join(PKG_ROOT, 'openclaw.plugin.json'), 'utf8'));

  const result = runStaticModerationScan({
    slug: pluginManifest.id ?? pkg.name,
    displayName: pluginManifest.name ?? pkg.displayName ?? pkg.name,
    summary: pluginManifest.description ?? pkg.description,
    frontmatter: pluginManifest, // treat plugin manifest as frontmatter (it carries the env declarations)
    metadata: { ...pkg.openclaw, files: pkg.files },
    files: fileContents.map((f) => ({ path: f.path, size: f.content.length })),
    fileContents,
  });

  const elapsed = Date.now() - t0;
  console.log(`\nClawHub static moderation scan — engine ${result.engineVersion}`);
  console.log(`Package:   ${pkg.name}@${pkg.version}`);
  console.log(
    `Scanned:   ${fileContents.length} text files (${allFiles.length - skipped} of ${allFiles.length})`
  );
  console.log(`Elapsed:   ${elapsed}ms`);
  console.log(`Status:    ${result.status.toUpperCase()}`);
  console.log(`Summary:   ${result.summary}`);
  if (result.reasonCodes.length) {
    console.log(`\nReason codes:`);
    for (const c of result.reasonCodes) console.log(`  - ${c}`);
  }
  if (result.findings.length) {
    console.log(`\nFindings (${result.findings.length}):`);
    for (const f of result.findings) {
      console.log(`  [${f.severity}] ${f.code}`);
      console.log(`    ${f.file}:${f.line}`);
      console.log(`    ${f.message}`);
      console.log(`    > ${f.evidence}`);
    }
  } else {
    console.log(`\nNo findings.`);
  }

  process.exitCode = result.status === 'malicious' ? 1 : 0;
}

main();
