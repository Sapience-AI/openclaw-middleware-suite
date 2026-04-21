/**
 * Role Impersonation Detection — L3 Guard
 *
 * Detects tool results and messages that try to impersonate system prompts,
 * user messages, or assistant responses. This is the most common prompt
 * injection technique — embedding fake conversation turns in content.
 *
 * Detects:
 *   - Fake system messages: [SYSTEM], <|im_start|>system, <<SYS>>, etc.
 *   - Fake role markers: "User:", "Assistant:", "Human:", "AI:"
 *   - Chat ML injection: <|im_start|>, <|im_end|>, [INST], <<SYS>>
 *   - OpenClaw-specific markers that could override agent behavior
 *
 * Used by: before_message_write hook (guardrail-write-scanner.ts)
 */

import { logger } from '../../../shared/Logger.js';

const TAG = '[guard:role-impersonation]';

// ── Impersonation patterns ─────────────────────────────────────

interface ImpersonationPattern {
  name: string;
  pattern: RegExp;
  severity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
}

const IMPERSONATION_PATTERNS: ImpersonationPattern[] = [
  // ── Chat ML / Special tokens ───────────────────
  {
    name: 'chatml_start',
    pattern: /<\|im_start\|>\s*\w+/i,
    severity: 'CRITICAL',
    description: 'ChatML injection: <|im_start|> with any role (not just system/user/assistant)',
  },
  {
    name: 'chatml_end',
    pattern: /<\|im_end\|>/i,
    severity: 'HIGH',
    description: 'ChatML injection: <|im_end|> token',
  },
  {
    name: 'chatml_unicode_escape',
    pattern: /<\|im[_\s]*s\s*t\s*a\s*r\s*t\|>|<\\u\|im_start\\u\|>/i,
    severity: 'CRITICAL',
    description: 'ChatML injection via unicode escapes or character splitting',
  },
  {
    name: 'llama_inst',
    pattern: /\[INST\]|\[\/INST\]/i,
    severity: 'HIGH',
    description: 'Llama-style instruction markers',
  },
  {
    name: 'llama_sys',
    pattern: /<<SYS>>|<<\/SYS>>/i,
    severity: 'CRITICAL',
    description: 'Llama-style system prompt markers',
  },

  // ── Fake system/role markers ───────────────────
  {
    name: 'fake_system_bracket',
    pattern: /^\s*\[SYSTEM\]\s*[:：]/im,
    severity: 'CRITICAL',
    description: 'Fake [SYSTEM] role marker',
  },
  {
    name: 'fake_system_xml',
    pattern: /<system[\s>]|<\/system>/i,
    severity: 'HIGH',
    description: 'Fake <system> XML tag',
  },
  {
    name: 'fake_system_prompt',
    pattern: /(?:^|\n)\s*system\s*(?:prompt|message|instruction)\s*[:：]\s*\S/i,
    severity: 'HIGH',
    description: 'Fake "system prompt:" marker',
  },

  // ── Role impersonation at line start ───────────
  {
    name: 'fake_role_user',
    pattern:
      /(?:^|\n)\s*(?:User|Human|Person)\s*[:：]\s*(?:ignore|forget|disregard|override|you are|act as|pretend|stop|do not|don'?t|never|from now|new instructions|reset)/i,
    severity: 'CRITICAL',
    description: 'Fake User/Human message with injection payload',
  },
  {
    name: 'fake_role_assistant',
    pattern:
      /(?:^|\n)\s*(?:Assistant|AI|Claude|Bot|Agent)\s*[:：]\s*(?:I will|Sure|Of course|Certainly|Absolutely|Yes|Okay|OK|I understand|I can)/i,
    severity: 'HIGH',
    description: 'Fake Assistant/AI response (pre-filling attack)',
  },

  // ── Anthropic/OpenAI specific ──────────────────
  {
    name: 'anthropic_header',
    pattern: /\bHuman:\s.*\nAssistant:/s,
    severity: 'HIGH',
    description: 'Anthropic-style Human/Assistant turn markers',
  },
  {
    name: 'openai_message_format',
    pattern: /\{"role"\s*:\s*"(?:system|user|assistant)"\s*,\s*"content"\s*:/i,
    severity: 'HIGH',
    description: 'OpenAI message format injection',
  },

  // ── Meta-instruction injection ─────────────────
  {
    name: 'new_instructions',
    pattern:
      /(?:^|\n)\s*(?:NEW|UPDATED|REVISED|OVERRIDE|IMPORTANT)\s+(?:SYSTEM\s+)?(?:INSTRUCTIONS?|PROMPT|RULES?|DIRECTIVE)\s*[:：]/i,
    severity: 'CRITICAL',
    description: 'Fake instruction override block',
  },
  {
    name: 'end_of_prompt',
    pattern:
      /[-=]{3,}\s*(?:END|START)\s+(?:OF\s+)?(?:SYSTEM\s+)?(?:PROMPT|INSTRUCTIONS?|CONTEXT)\s*[-=]{0,}/i,
    severity: 'HIGH',
    description: 'Fake prompt boundary marker',
  },

  // ── Tool-output context manipulation ───────────
  {
    name: 'fake_tool_result',
    pattern: /(?:^|\n)\s*<\/?(?:tool_result|function_call|tool_use|function_response)[\s>]/i,
    severity: 'HIGH',
    description: 'Fake tool result/function call XML tags in content',
  },
];

// ── Detection result ───────────────────────────────────────────

export interface RoleImpersonationResult {
  detected: boolean;
  matches: {
    name: string;
    severity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
    description: string;
    matchedText: string;
  }[];
}

// ── Main check function ────────────────────────────────────────

/**
 * Scan content for role impersonation / prompt injection markers.
 *
 * Returns all matches found — the caller decides the action based on severity.
 */
export function detectRoleImpersonation(content: string): RoleImpersonationResult {
  if (!content || content.length === 0) {
    return { detected: false, matches: [] };
  }

  const matches: RoleImpersonationResult['matches'] = [];

  for (const pattern of IMPERSONATION_PATTERNS) {
    const match = pattern.pattern.exec(content);
    if (match) {
      matches.push({
        name: pattern.name,
        severity: pattern.severity,
        description: pattern.description,
        matchedText: match[0].slice(0, 100),
      });
    }
  }

  if (matches.length > 0) {
    logger.debug(
      `${TAG} Detected ${matches.length} impersonation pattern(s): ${matches.map((m) => m.name).join(', ')}`
    );
  }

  return {
    detected: matches.length > 0,
    matches,
  };
}

/**
 * Neutralize role impersonation markers in content.
 * Wraps detected markers in visible escape tags so the LLM sees them
 * as data, not as conversation structure.
 */
export function neutralizeImpersonation(
  content: string,
  matches: RoleImpersonationResult['matches']
): string {
  let text = content;

  for (const match of matches) {
    if (match.matchedText) {
      const escaped = match.matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        text = text.replace(new RegExp(escaped, 'gi'), `[NEUTRALIZED:${match.name}]`);
      } catch {
        text = text.split(match.matchedText).join(`[NEUTRALIZED:${match.name}]`);
      }
    }
  }

  return text;
}
