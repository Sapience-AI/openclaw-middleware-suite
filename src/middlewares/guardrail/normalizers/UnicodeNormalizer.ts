/**
 * Unicode Normalizer — prevents homoglyph bypass attacks
 *
 * Applies NFKC normalization and maps known homoglyphs that NFKC misses.
 * Converts Cyrillic "а" → Latin "a", removes zero-width characters, etc.
 */

// Homoglyphs that NFKC normalization doesn't resolve
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic → Latin
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043E': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0456': 'i',
  '\u0410': 'A',
  '\u0415': 'E',
  '\u041E': 'O',
  '\u0420': 'P',
  '\u0421': 'C',
  '\u0423': 'Y',
  '\u0425': 'X',
  '\u0406': 'I',
  // Greek → Latin
  '\u03B1': 'a',
  '\u03B5': 'e',
  '\u03BF': 'o',
  '\u03C1': 'p',
  '\u0391': 'A',
  '\u0395': 'E',
  '\u039F': 'O',
  '\u03A1': 'P',
  // Zero-width / invisible characters → removed
  '\u200B': '', // zero-width space
  '\u200C': '', // zero-width non-joiner
  '\u200D': '', // zero-width joiner
  '\uFEFF': '', // byte order mark
  '\u00AD': '', // soft hyphen
};

/**
 * Normalize text to defeat Unicode-based injection bypass.
 * 1. NFKC normalization (fullwidth → ASCII, ligatures → base chars)
 * 2. Homoglyph replacement (Cyrillic/Greek lookalikes → Latin)
 * 3. Zero-width character removal
 */
export function normalizeUnicode(text: string): string {
  let normalized = text.normalize('NFKC');

  for (const [glyph, replacement] of Object.entries(HOMOGLYPH_MAP)) {
    normalized = normalized.split(glyph).join(replacement);
  }

  return normalized;
}
