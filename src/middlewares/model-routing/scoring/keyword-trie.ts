/**
 * Keyword Trie — Aho-Corasick-style multi-keyword scanner with word-boundary
 * detection and density clustering bonus.
 *
 * Ported from Manifest's keyword-trie.ts and extended with density clustering.
 *
 * Word boundaries: a match is only valid if the character immediately before
 * the match start and the character immediately after the match end are NOT
 * word characters ([0-9A-Za-z_]). This prevents "proof" matching in
 * "waterproof", "function" matching in "functional", etc.
 *
 * Density clustering: if 3+ matches for a dimension fall within a 200-char
 * window, the effective match count is multiplied by 1.5× (rounded up).
 * This rewards focused technical passages over scattered keyword mentions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrieMatch {
  keyword: string;
  dimension: string;
  position: number;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  terminals: Array<{ keyword: string; dimension: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNode(): TrieNode {
  return { children: new Map(), terminals: [] };
}

/**
 * Returns true for characters that form "word" boundaries: [0-9A-Za-z_].
 * Non-ASCII characters (CJK, Arabic, Cyrillic, etc.) return false, which means
 * they are treated as non-word characters — multilingual keywords are always
 * considered to have valid boundaries around them.
 */
export function isWordCharCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}

// ---------------------------------------------------------------------------
// Density clustering
// ---------------------------------------------------------------------------

const CLUSTER_WINDOW = 200; // chars
const CLUSTER_MIN = 3; // minimum matches to trigger
const CLUSTER_BOOST = 1.5; // multiplier

/**
 * Given an array of match positions for a single dimension, returns a
 * potentially-boosted effective match count.
 *
 * If any CLUSTER_MIN consecutive positions (by sorted order) all fall within
 * a CLUSTER_WINDOW-char span, the raw count is multiplied by CLUSTER_BOOST
 * and rounded up.
 */
export function applyDensityClustering(positions: number[]): number {
  const n = positions.length;
  if (n < CLUSTER_MIN) return n;

  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 0; i <= sorted.length - CLUSTER_MIN; i++) {
    if (sorted[i + CLUSTER_MIN - 1] - sorted[i] <= CLUSTER_WINDOW) {
      return Math.ceil(n * CLUSTER_BOOST);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// KeywordTrie
// ---------------------------------------------------------------------------

export class KeywordTrie {
  private readonly root: TrieNode = createNode();
  private _size = 0;

  /** Max characters to scan per request. Inputs beyond this are truncated. */
  static readonly MAX_SCAN_LENGTH = 100_000;

  constructor(dimensions: Array<{ name: string; keywords: string[] }>) {
    for (const dim of dimensions) {
      for (const keyword of dim.keywords) {
        this.insert(keyword.toLowerCase(), keyword.toLowerCase(), dim.name);
      }
    }
  }

  private insert(chars: string, keyword: string, dimension: string): void {
    let node = this.root;
    for (const ch of chars) {
      let child = node.children.get(ch);
      if (!child) {
        child = createNode();
        node.children.set(ch, child);
      }
      node = child;
    }
    node.terminals.push({ keyword, dimension });
    this._size++;
  }

  /**
   * Scan text for all keyword matches, enforcing word boundaries.
   * Returns one TrieMatch per keyword hit (not deduplicated across positions).
   */
  scan(text: string): TrieMatch[] {
    const matches: TrieMatch[] = [];
    const lower = text.toLowerCase();
    const len = Math.min(lower.length, KeywordTrie.MAX_SCAN_LENGTH);

    for (let i = 0; i < len; i++) {
      // Skip positions where the preceding char is a word char (mid-word)
      if (i > 0 && isWordCharCode(lower.charCodeAt(i - 1))) continue;

      let node = this.root;
      for (let j = i; j < len; j++) {
        const child = node.children.get(lower[j]);
        if (!child) break;
        node = child;

        if (node.terminals.length > 0) {
          // Check that the char after the match is not a word char
          const afterIdx = j + 1;
          if (afterIdx < len && isWordCharCode(lower.charCodeAt(afterIdx))) {
            continue;
          }
          for (const terminal of node.terminals) {
            matches.push({ keyword: terminal.keyword, dimension: terminal.dimension, position: i });
          }
        }
      }
    }

    return matches;
  }

  get size(): number {
    return this._size;
  }
}
