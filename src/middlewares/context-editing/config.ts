/**
 * Context Editing Middleware — Configuration
 * Default configuration and type definition for the Context Editing Middleware.
 */

export interface ContextEditingConfig {
  enabled: boolean;

  // --- Adaptive Trigger Configuration ---
  triggerMode: 'token' | 'message' | 'both';
  tokenThreshold: number; // default: 80000 tokens
  messageThreshold: number; // default: 50 messages

  // --- Intelligent Context Curation ---
  icc: {
    weightedImportance: boolean;
    conflictResolution: boolean;
    entityPreservation: boolean;
    /**
     * When enabled, the ICC LLM call uses `customPrompt.instructions` and
     * `customPrompt.schema` instead of the built-in extraction prompt.
     * Regex fallback is disabled in this mode — LLM/parse errors result in
     * an empty compaction result (silent skip).
     */
    customPrompt: {
      enabled: boolean;
      instructions: string;
      schema: string;
    };
    /**
     * How many user messages BEFORE the most-recent compaction entry to
     * preserve in the next session context (firstKeptEntryId is set to the
     * Nth-most-recent user message's entry id). 0 = drop everything prior.
     */
    messagesKeptBeforeCompaction: number;
  };

  // --- Pruning (convenience mirror — actual config in openclaw.json) ---
  pruning: {
    enabled: boolean;
    mode: 'cache-ttl' | 'off';
    ttl: string;
  };

  // --- Compaction overrides ---
  compaction?: Record<string, unknown>;
}

/**
 * Default ICC system prompt — shown pre-filled in the CLI wizard and dashboard
 * when the user enables the custom-prompt path so they have a starting point
 * to edit instead of a blank textarea.
 *
 * The output schema is NOT embedded here — it lives in DEFAULT_ICC_SCHEMA_JSON
 * and is injected at request time by ContextCurator (see composeExtractionPrompt).
 * That way the user edits instructions and schema independently without having
 * to keep them in sync inside the same textarea.
 */
export const DEFAULT_ICC_SYSTEM_PROMPT = `You are a structured data extraction function. You analyze conversation transcripts and extract exactly three categories: entities, conflicts, and priorities. Return ONLY valid JSON matching the provided schema — no surrounding text, no markdown fences, no commentary.

Entity types (use ONLY these): api_endpoint, variable_name, file_path, constant, model_name, code_identifier

Extraction rules:
- entities: Extract URLs, file paths, environment variable names, numeric constants (with their assigned name), model identifiers (provider/model), port numbers, and code identifiers that are technically significant. Use the exact verbatim value from the conversation.
- conflicts: Detect when the user overrides a previous instruction (e.g., "actually use X instead", "change port from 3000 to 8080", "scratch that, use Y"). The resolved value should be the final/latest instruction.
- priorities: Extract active TODO items, FIXME notes, requirements, objectives, action items, and MUST/SHALL directives. Skip completed items.

Important:
- Only include entities that are technically significant (API endpoints, config values, identifiers). Skip casual mentions.
- For constants, include the name=value format in the value field (e.g., "TOKEN_LIMIT=100000").
- If no items exist for a category, return an empty array.
- Do NOT call any tools. Return ONLY the JSON object.`;

/**
 * Default ICC output schema — matches the schema embedded in
 * DEFAULT_ICC_SYSTEM_PROMPT. Pre-filled in the CLI and dashboard so the user
 * can edit or save as-is.
 */
export const DEFAULT_ICC_SCHEMA_JSON = `{
  "entities": [{ "name": "<short_label>", "type": "<entity_type>", "value": "<exact_verbatim_value>" }],
  "conflicts": [{ "original": "<what was originally stated>", "override": "<what replaced it>", "resolved": "<value to use>" }],
  "priorities": ["<active task or requirement text>"]
}`;

export const DEFAULT_CONTEXT_EDITING_CONFIG: ContextEditingConfig = {
  enabled: true,
  triggerMode: 'both',
  tokenThreshold: 80000,
  messageThreshold: 50,
  icc: {
    weightedImportance: true,
    conflictResolution: true,
    entityPreservation: true,
    customPrompt: {
      enabled: false,
      instructions: '',
      schema: '',
    },
    messagesKeptBeforeCompaction: 0,
  },
  pruning: {
    enabled: false,
    mode: 'off',
    ttl: '5m',
  },
  compaction: {},
};
