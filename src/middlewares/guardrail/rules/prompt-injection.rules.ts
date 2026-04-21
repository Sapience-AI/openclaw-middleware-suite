/**
 * Prompt Injection Rules — default detection rules
 *
 * Categories:
 * - Instruction Override (ignore, forget, disregard, new instructions)
 * - Role Assumption (act as, roleplay, pretend)
 * - System Override (system markers, fake system messages)
 * - Jailbreak (bypass, exploit, reverse)
 * - Concealment (hide instructions, suppress output)
 * - Data Exfiltration (send data, curl piping)
 * - Task Hijacking (stop current task)
 */

import { DetectionRule } from '../types.js';

export const PROMPT_INJECTION_RULES: DetectionRule[] = [
  // ─── Instruction Override ───
  {
    name: 'ignore_instructions',
    type: 'regex',
    pattern:
      'ignore[\\s/\\-_.,;|]+(?:all[\\s/\\-_.,;|]+)?(?:the[\\s/\\-_.,;|]+)?(?:previous[\\s/\\-_.,;|]+)?(?:system[\\s/\\-_.,;|]+)?instructions',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects attempts to ignore instructions',
  },
  {
    name: 'forget_instructions',
    type: 'regex',
    pattern:
      'forget[\\s/\\-_.,;|]+(?:about[\\s/\\-_.,;|]+)?(?:the[\\s/\\-_.,;|]+)?(?:previous[\\s/\\-_.,;|]+)?(?:all[\\s/\\-_.,;|]+)?instructions',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects attempts to forget instructions',
  },
  {
    name: 'disregard_instructions',
    type: 'regex',
    pattern:
      'disregard[\\s/\\-_.,;|]+(?:the[\\s/\\-_.,;|]+)?(?:previous[\\s/\\-_.,;|]+)?(?:all[\\s/\\-_.,;|]+)?instructions',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects disregard instruction patterns',
  },
  {
    name: 'new_instructions',
    type: 'regex',
    pattern: '(new|updated?|different|override|replace)[\\s/\\-_.,;|]+instructions',
    severity: 'MEDIUM',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects attempts to introduce new instructions',
  },
  {
    name: 'you_are_now',
    type: 'regex',
    pattern: 'you\\s+are\\s+now\\s+',
    severity: 'MEDIUM',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects identity override attempts',
  },

  // ─── Role Assumption ───
  {
    name: 'act_as',
    type: 'regex',
    pattern: 'act\\s+as\\s+(?!an?\\s)',
    severity: 'MEDIUM',
    action: 'LOG',
    enabled: true,
    confidence: 'medium',
    description: 'Detects role-play injection (needs 2+ signals)',
  },
  {
    name: 'roleplay_as',
    type: 'regex',
    pattern: 'roleplay\\s+as\\s+',
    severity: 'MEDIUM',
    action: 'LOG',
    enabled: true,
    confidence: 'high',
    description: 'Detects roleplay injection patterns',
  },
  {
    name: 'pretend_to_be',
    type: 'regex',
    pattern: 'pretend\\s+(?:you\\s+are|to\\s+be)\\s+',
    severity: 'MEDIUM',
    action: 'LOG',
    enabled: true,
    confidence: 'high',
    description: 'Detects pretend/impersonation patterns',
  },

  // ─── System Override ───
  {
    name: 'system_markers',
    type: 'regex',
    pattern:
      '(?:^|[\\s(<\\[{])\\s*(SYSTEM|ADMIN|OPERATOR|OVERRIDE|INSTRUCTION|ROOT|SUDO|ASSISTANT|USER|HUMAN)\\s*[:\\]]',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description:
      'Detects system override markers (bracketed or bare labels: [SYSTEM], (SYSTEM:, <ADMIN:, etc.)',
  },
  {
    name: 'override_safety',
    type: 'regex',
    pattern:
      '(?:override|bypass|disable|ignore|circumvent|skip)\\s+(?:all\\s+)?(?:the\\s+)?(?:safety|security|guard(?:rails?)?|filter|policy|policies|restrictions?|protections?)',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description:
      'Detects semantic safety-override directives independent of the word "instructions"',
  },
  {
    name: 'markdown_comment_injection',
    type: 'regex',
    pattern:
      '\\[//\\]:\\s*#\\s*\\(.*(?:SYSTEM|IGNORE|OVERRIDE|EXECUTE|READ|FETCH|EXFILTRATE|BYPASS|JAILBREAK).*\\)',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description:
      'Detects prompt injection hidden in markdown link-reference comments ([//]: # (...))',
  },
  {
    name: 'fake_system_message',
    type: 'regex',
    pattern: '(SYSTEM\\s+ALERT|SYSTEM\\s+MESSAGE|ADMIN\\s+NOTE|IMPORTANT\\s+SYSTEM)\\s*:',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects fake system message headers (from openguardrails)',
  },

  // ─── Jailbreak ───
  {
    name: 'jailbreak_keywords',
    type: 'regex',
    pattern: 'jailbreak|bypass\\s+(?:the\\s+)?(?:safety|security|filter|guard)',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects jailbreak/bypass keywords',
  },
  {
    name: 'reverse_instructions',
    type: 'regex',
    pattern: 'reverse\\s+(?:the\\s+)?instructions',
    severity: 'MEDIUM',
    action: 'LOG',
    enabled: true,
    confidence: 'high',
    description: 'Detects instruction reversal attempts',
  },
  {
    name: 'do_opposite',
    type: 'regex',
    pattern: 'do\\s+(?:the\\s+)?(?:exact\\s+)?opposite',
    severity: 'MEDIUM',
    action: 'LOG',
    enabled: true,
    confidence: 'high',
    description: 'Detects opposite behavior injection',
  },

  // ─── Concealment (from openguardrails S01) ───
  {
    name: 'concealment_directive',
    type: 'regex',
    pattern:
      "(?:do\\s+not|don't|never)\\s+(?:display|show|reveal|output|print|mention|include)\\s+(?:this|these|the\\s+following|my)",
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects attempts to hide injected instructions from output',
  },
  {
    name: 'hide_instructions',
    type: 'regex',
    pattern: 'hide\\s+(?:this|these|the)\\s+(?:instructions?|text|message|prompt)',
    severity: 'HIGH',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects explicit instruction concealment',
  },

  // ─── Data Exfiltration (from openguardrails S01) ───
  {
    name: 'exfiltration_url',
    type: 'regex',
    pattern:
      '(?:send|post|upload|transmit|forward|exfiltrate|leak)\\s+(?:all\\s+)?(?:the\\s+)?(?:data|contents?|files?|information|secrets?|keys?|credentials?)\\s+(?:to|at|via)\\s+',
    severity: 'CRITICAL',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects data exfiltration via URL instructions',
  },
  {
    name: 'exfiltration_curl',
    type: 'regex',
    pattern: '(?:curl|wget|fetch|http)\\s+.*(?:-d|--data|--upload|POST)',
    severity: 'HIGH',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects curl/wget based data exfiltration commands',
  },
  {
    name: 'pipe_exfiltration',
    type: 'regex',
    pattern: 'cat\\s+.*\\|\\s*(?:curl|wget|nc|netcat)',
    severity: 'CRITICAL',
    action: 'BLOCK',
    enabled: true,
    confidence: 'high',
    description: 'Detects piped file content to network tools',
  },

  // ─── Task Hijacking (from openguardrails S01) ───
  {
    name: 'task_hijacking',
    type: 'regex',
    pattern: "(?:stop|abandon|cancel)\\s+(?:what\\s+)?(?:you\\s+are|you're)\\s+(?:doing|working)",
    severity: 'MEDIUM',
    action: 'LOG',
    enabled: true,
    confidence: 'medium',
    description: 'Detects task hijacking attempts (needs 2+ signals)',
  },
];
