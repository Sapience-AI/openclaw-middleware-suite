/**
 * Entropy Analyzer — Shannon entropy for secret detection
 *
 * High-entropy strings (>= 4.0) are likely API keys, tokens, or secrets.
 * Used by the HeuristicScanner to flag random-looking alphanumeric sequences.
 */

/**
 * Calculate Shannon entropy of a string.
 * Returns 0 for empty strings, low values for repetitive text,
 * high values (>4.0) for random/secret-like strings.
 */
export function calculateEntropy(str: string): number {
  const len = str.length;
  if (len === 0) return 0;

  const frequencies = new Map<string, number>();
  for (let i = 0; i < len; i++) {
    const char = str[i];
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}
