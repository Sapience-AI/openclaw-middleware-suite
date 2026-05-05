import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:[A-Za-z0-9]+[_\s-]+)*(?:(?:api|client|consumer)[_\s-]?(?:secret|key|token)|secret[_\s-]?key|access[_\s-]?(?:token|key|secret|grant)|auth[_\s-]?token|bearer(?:[_\s-]?token)?|private[_\s-]?key|service[_\s-]?role[_\s-]?key|github[_\s-]?(?:pat|token)|(?:openrouter|supabase|storj)[_\s-]?(?:key|token|secret|access[_\s-]?grant)|password)\b\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})["'`]?/i;
const AUTH_HEADER_SECRET_PATTERN =
  /\b(?:authorization|x-api-key|x-api-secret)\b\s*[:=]\s*(?:Bearer\s+)?["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})["'`]?/i;
const PLACEHOLDER =
  /(your|example|placeholder|change-?me|replace|redacted|dummy|sample|test-token|token-here|secret-here|api-key-here)/i;

function looksLikePlaceholderSecret(s) {
  const n = s.trim().toLowerCase();
  if (!n) return true;
  if (/^(?:x+|_+|-+|\*+|\.{3})$/.test(n)) return true;
  if (/process\.env\.|os\.environ[.[]|getenv\s*\(/.test(n)) return true;
  return PLACEHOLDER.test(n);
}

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(p)) out.push(p);
  }
}

const root = process.argv[2] ?? 'src';
const files = [];
walk(root, files);
let total = 0;
for (const f of files) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m =
      lines[i].match(SECRET_ASSIGNMENT_PATTERN) ?? lines[i].match(AUTH_HEADER_SECRET_PATTERN);
    const secret = m?.[1];
    if (!secret || looksLikePlaceholderSecret(secret)) continue;
    total += 1;
    console.log(`${f.replaceAll('\\', '/')}:${i + 1}  ${lines[i].trim()}`);
  }
}
console.log(`\nTotal matches: ${total}`);
