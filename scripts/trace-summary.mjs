#!/usr/bin/env node
/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * trace-summary — pretty-print an OpenClaw `*.jsonl` trajectory trace.
 *
 * Schema reminder:
 *   - One `.jsonl` file = one conversation, identified by `sessionId`
 *     (matches the filename).
 *   - Inside the file, each `session.started` → `session.ended` bracket
 *     delimits one *agent run* — i.e., one user-turn (the bracket has
 *     its own `runId`).  A conversation with two turns therefore has
 *     two `session.started` events under the same `sessionId`.
 *   - Each agent run emits ~7 events: session.started, trace.metadata,
 *     context.compiled, prompt.submitted, model.completed, trace.artifacts,
 *     session.ended.  Payloads are dense (system prompts, full message
 *     snapshots, tool catalogs, control-UI sender envelopes, timestamp
 *     wrappers, etc).
 *
 * This script groups the events by `sessionId` so one file renders as one
 * conversation card with N turns inside, and within each turn extracts only
 * the parts a human actually wants when debugging:
 *
 *   - Conversation header: sessionId, model, trigger, harness, tool count
 *   - Per-turn block: runId, timeline, user message (envelope-stripped),
 *     assistant response (truncated), token usage, final status
 *
 * Usage:
 *   node scripts/trace-summary.mjs <path/to/session.jsonl>
 *   node scripts/trace-summary.mjs                         # defaults to test/context-editing/session.jsonl
 *   node scripts/trace-summary.mjs --full <path>           # don't truncate assistant text
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── arg parsing ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opts = { full: false, file: null };
for (const a of argv) {
  if (a === '--full' || a === '-f') opts.full = true;
  else if (a === '--help' || a === '-h') {
    console.log(
      'Usage: node scripts/trace-summary.mjs [--full] [<path/to/session.jsonl>]\n' +
        '\n' +
        '  --full, -f   show full assistant text (default: truncate to ~6 lines)\n' +
        '  <path>       trace file (default: test/context-editing/session.jsonl)',
    );
    process.exit(0);
  } else if (!opts.file) opts.file = a;
}

const filePath = opts.file
  ? path.resolve(opts.file)
  : path.resolve(process.cwd(), 'test/context-editing/session.jsonl');

if (!fs.existsSync(filePath)) {
  console.error(`trace-summary: file not found: ${filePath}`);
  process.exit(1);
}

// ── envelope strippers (mirrors CE's extractCleanedTextForICC) ──────────────

const SENDER_META_RE =
  /Sender \(untrusted metadata\):\s*(?:```json?\s*)?\{[\s\S]*?\}\s*(?:```\s*)?/;
const TIMESTAMP_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\s*/;

function stripEnvelopes(text) {
  if (typeof text !== 'string') return '';
  return text.replace(SENDER_META_RE, '').replace(TIMESTAMP_RE, '').trim();
}

function extractMessageText(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

// ── parse JSONL ─────────────────────────────────────────────────────────────

const lines = fs
  .readFileSync(filePath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

const events = [];
for (let i = 0; i < lines.length; i++) {
  try {
    events.push(JSON.parse(lines[i]));
  } catch (err) {
    console.warn(`trace-summary: skipping unparseable line ${i + 1}: ${err.message}`);
  }
}

// ── group events first into turns (delimited by session.started/ended), ────
// ── then into conversations (grouped by sessionId).  ───────────────────────

const turns = [];
let currentTurn = null;
for (const e of events) {
  if (e.type === 'session.started') {
    currentTurn = {
      sessionId: e.sessionId,
      runId: e.runId,
      events: [e],
      byType: { 'session.started': e },
    };
    turns.push(currentTurn);
  } else if (currentTurn) {
    currentTurn.events.push(e);
    currentTurn.byType[e.type] = e;
  }
}

// Group turns into conversations, preserving first-seen order.
const conversationOrder = [];
const conversationsById = new Map();
for (const t of turns) {
  if (!conversationsById.has(t.sessionId)) {
    conversationsById.set(t.sessionId, { sessionId: t.sessionId, turns: [] });
    conversationOrder.push(t.sessionId);
  }
  conversationsById.get(t.sessionId).turns.push(t);
}
const conversations = conversationOrder.map((id) => conversationsById.get(id));

// ── formatting helpers ──────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const useColor = process.stdout.isTTY;

function c(color, s) {
  return useColor ? `${color}${s}${RESET}` : s;
}

function tsLocal(iso) {
  if (!iso) return '            ';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function indentBlock(text, prefix) {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function truncateLines(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const shown = lines.slice(0, maxLines).join('\n');
  return `${shown}\n${c(DIM, `[... ${lines.length - maxLines} more line${lines.length - maxLines === 1 ? '' : 's'} truncated; pass --full to show all]`)}`;
}

// ── render a single turn (one session.started/ended bracket) ───────────────

function renderTurn(turn, turnIdx, totalTurns) {
  const started = turn.byType['session.started'];
  const ctx = turn.byType['context.compiled'];
  const prompt = turn.byType['prompt.submitted'];
  const completed = turn.byType['model.completed'];
  const ended = turn.byType['session.ended'];
  const artifacts = turn.byType['trace.artifacts'];

  const cd = ctx?.data || {};
  const pd = prompt?.data || {};
  const md2 = completed?.data || {};
  const ed = ended?.data || {};

  const startMs = started ? new Date(started.ts).getTime() : 0;
  const endMs = ended ? new Date(ended.ts).getTime() : 0;
  const durationMs = endMs && startMs ? endMs - startMs : 0;

  const out = [];
  const turnLabel = `Turn ${turnIdx + 1}/${totalTurns}`;
  const dur = durationMs ? `${(durationMs / 1000).toFixed(2)}s` : '?';
  out.push(
    `│  ${c(BOLD, '─── ' + turnLabel + ' ───')} ${c(DIM, `runId ${turn.runId || '?'}`)} · ${dur}`,
  );

  if (started) out.push(`│  [${tsLocal(started.ts)}]  ${c(CYAN, 'session.started')}`);

  if (ctx) {
    const sysChars =
      typeof cd.systemPrompt === 'string' ? cd.systemPrompt.length : (cd.systemPrompt?.length ?? 0);
    const histLen = Array.isArray(cd.messages) ? cd.messages.length : 0;
    const toolCount = Array.isArray(cd.tools) ? cd.tools.length : 0;
    out.push(
      `│  [${tsLocal(ctx.ts)}]  ${c(CYAN, 'context.compiled')}    sys=${sysChars}ch  history=${histLen} msgs  tools=${toolCount}`,
    );
  }

  if (prompt) {
    out.push(`│  [${tsLocal(prompt.ts)}]  ${c(CYAN, 'prompt.submitted')}`);
    const userText = stripEnvelopes(typeof pd.prompt === 'string' ? pd.prompt : '');
    if (userText) {
      out.push(`│                  ${c(YELLOW, 'user')} › ${JSON.stringify(userText)}`);
    } else {
      out.push(`│                  ${c(DIM, '(empty / media-only)')}`);
    }
    if (pd.imagesCount) {
      out.push(
        `│                  ${c(DIM, `[+${pd.imagesCount} image${pd.imagesCount === 1 ? '' : 's'}]`)}`,
      );
    }
  }

  if (completed) {
    const u = md2.usage || {};
    const cache = md2.promptCache?.lastCallUsage || {};
    const flags = [];
    if (md2.aborted) flags.push(c(RED, 'ABORTED'));
    if (md2.externalAbort) flags.push(c(RED, 'EXTERNAL_ABORT'));
    if (md2.timedOut) flags.push(c(RED, 'TIMEOUT'));
    if (md2.idleTimedOut) flags.push(c(RED, 'IDLE_TIMEOUT'));
    if (md2.promptErrorSource) flags.push(c(RED, `ERR:${md2.promptErrorSource}`));
    const flagStr = flags.length ? ' · ' + flags.join(' ') : '';

    out.push(
      `│  [${tsLocal(completed.ts)}]  ${c(CYAN, 'model.completed')}     in=${u.input ?? '?'}  out=${u.output ?? '?'}  cacheR=${cache.cacheRead ?? 0}  cacheW=${cache.cacheWrite ?? 0}${flagStr}`,
    );

    const texts = Array.isArray(md2.assistantTexts) ? md2.assistantTexts : [];
    if (texts.length === 0) {
      out.push(`│                  ${c(DIM, '(no assistant text)')}`);
    } else {
      texts.forEach((t, i) => {
        const text = typeof t === 'string' ? t : extractMessageText(t);
        const charCount = text.length;
        const label = texts.length > 1 ? `assistant[${i}]` : 'assistant';
        out.push(`│                  ${c(GREEN, label)} (${charCount} chars) ›`);
        const body = opts.full ? text : truncateLines(text, 6);
        out.push(indentBlock(body, '│                    '));
      });
    }

    if (md2.compactionCount) {
      out.push(`│                  ${c(YELLOW, `compactions=${md2.compactionCount}`)}`);
    }
  }

  if (artifacts) {
    const ad = artifacts.data || {};
    if (ad.finalStatus && ad.finalStatus !== 'completed' && ad.finalStatus !== 'success') {
      out.push(
        `│  [${tsLocal(artifacts.ts)}]  ${c(CYAN, 'trace.artifacts')}     status=${ad.finalStatus}`,
      );
    }
  }

  if (ended) {
    const status = ed.status || 'unknown';
    const tag =
      status === 'completed' || status === 'success'
        ? c(GREEN, status)
        : ed.aborted || ed.timedOut
          ? c(RED, status)
          : status;
    out.push(`│  [${tsLocal(ended.ts)}]  ${c(CYAN, 'session.ended')}       status=${tag}`);
  }

  return out.join('\n');
}

// ── render a conversation (sessionId-scoped, with N turns inside) ──────────

function renderConversation(conv, idx) {
  // Pull header info from the FIRST turn's metadata (harness/model are
  // recorded per-run but should be identical across turns of the same
  // conversation).
  const firstTurn = conv.turns[0];
  const meta = firstTurn?.byType['trace.metadata'];
  const started = firstTurn?.byType['session.started'];
  const md = meta?.data || {};
  const sd = started?.data || {};

  const out = [];
  out.push('');
  out.push(c(BOLD, `╭─ Conversation ${idx + 1} · ${conv.turns.length} turn${conv.turns.length === 1 ? '' : 's'}`));
  out.push(`│  ${c(DIM, 'sessionId')}  ${conv.sessionId}`);
  if (md.harness) {
    const h = md.harness;
    const osPart =
      h.os && (h.os.platform || h.os.arch)
        ? `${h.os.platform || ''} ${h.os.arch || ''}`.trim()
        : '';
    const nodePart = h.runtime?.node ? `node ${h.runtime.node}` : '';
    const parts = [
      `${h.name || h.type || ''} ${h.version || ''}`.trim(),
      osPart,
      nodePart,
    ].filter(Boolean);
    out.push(`│  ${c(DIM, 'harness  ')}  ${parts.join(' · ')}`);
  }
  if (md.model || started?.provider) {
    const provider = md.model?.provider || started?.provider || '?';
    const name = md.model?.name || started?.modelId || '?';
    out.push(`│  ${c(DIM, 'model    ')}  ${provider}/${name}`);
  }
  out.push(
    `│  ${c(DIM, 'trigger  ')}  ${sd.trigger || '?'}${sd.messageProvider ? ` (${sd.messageProvider})` : ''}`,
  );
  out.push(
    `│  ${c(DIM, 'tools    ')}  ${sd.toolCount ?? '?'} server + ${sd.clientToolCount ?? 0} client`,
  );

  // Each turn rendered as an indented block under the conversation card.
  conv.turns.forEach((turn, i) => {
    out.push('│');
    out.push(renderTurn(turn, i, conv.turns.length));
  });

  out.push(c(BOLD, '╰─'));
  return out.join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────

const harness = turns[0]?.byType['trace.metadata']?.data?.harness;
const harnessLine = harness ? `${harness.name || harness.type} ${harness.version || ''}` : 'unknown';

console.log('');
console.log(c(BOLD, '═══════════════════════════════════════════════════════════════════════'));
console.log(`  trace:    ${path.relative(process.cwd(), filePath)}`);
console.log(
  `  events:   ${events.length}    conversations: ${conversations.length}    turns: ${turns.length}`,
);
console.log(`  harness:  ${harnessLine}`);
console.log(c(BOLD, '═══════════════════════════════════════════════════════════════════════'));

conversations.forEach((conv, i) => console.log(renderConversation(conv, i)));

// Aggregate footer — totals across every turn in the file.
const totals = turns.reduce(
  (acc, t) => {
    const u = t.byType['model.completed']?.data?.usage || {};
    const cache = t.byType['model.completed']?.data?.promptCache?.lastCallUsage || {};
    acc.input += u.input || 0;
    acc.output += u.output || 0;
    acc.cacheRead += cache.cacheRead || 0;
    acc.cacheWrite += cache.cacheWrite || 0;
    return acc;
  },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
);
console.log('');
console.log(c(DIM, '─── totals ────────────────────────────────────────────────────────────'));
console.log(
  `  in=${totals.input}  out=${totals.output}  cacheR=${totals.cacheRead}  cacheW=${totals.cacheWrite}    across ${turns.length} turn${turns.length === 1 ? '' : 's'}`,
);
console.log('');
