/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DlpDetection, DlpRule, SeverityLevel } from './types.js';

// Shannon entropy calculation to detect highly random strings (often secrets/keys)
function calculateEntropy(str: string): number {
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

export class ScannerEngine {
  private rules: DlpRule[] = [];

  constructor(rules: DlpRule[]) {
    this.rules = rules.filter((r) => r.enabled);
  }

  public scan(text: string): DlpDetection[] {
    const detections: DlpDetection[] = [];

    // 💡 Performance & Safety: Strip system tokens before scanning to avoid escalation loops.
    // We don't want to flag [SapienceMiddleware:...] tokens as magnitude/pii.
    const cleanText = text.replace(/\[SapienceMiddleware:[A-Z_]+\]/g, (match) =>
      ' '.repeat(match.length)
    );

    for (const rule of this.rules) {
      if (rule.type === 'regex') {
        const regex = new RegExp(rule.pattern, 'g');
        let match;
        while ((match = regex.exec(cleanText)) !== null) {
          this.addDetection(detections, rule, match[0], match.index, match.index + match[0].length);
        }
      } else if (rule.type === 'prefix') {
        // e.g. "sk-", "AKIA"
        const regex = new RegExp(`\\b${rule.pattern}[A-Za-z0-9_\\-]{16,}\\b`, 'g');
        let match;
        while ((match = regex.exec(cleanText)) !== null) {
          this.addDetection(detections, rule, match[0], match.index, match.index + match[0].length);
        }
      } else if (rule.type === 'heuristic') {
        // Find long alphanumeric words and check entropy
        const regex = /\b[A-Za-z0-9_\-+/]{20,}\b/g;
        let match;
        while ((match = regex.exec(cleanText)) !== null) {
          const word = match[0];
          const entropy = calculateEntropy(word);
          if (entropy > 4.5) {
            // High entropy threshold
            detections.push({
              originalPattern: rule.name,
              matchedString: word,
              startIndex: match.index,
              endIndex: match.index + word.length,
              severity: rule.severity,
              action: rule.action,
              replacementText: `[REDACTED_SECRET]`,
            });
          }
        }
      }
    }

    return detections;
  }

  private addDetection(
    detections: DlpDetection[],
    rule: DlpRule,
    matchedString: string,
    startIndex: number,
    endIndex: number
  ): void {
    detections.push({
      originalPattern: rule.name,
      matchedString,
      startIndex,
      endIndex,
      severity: rule.severity,
      action: rule.action,
      replacementText: this.getReplacementText(rule.name, matchedString, rule.severity),
    });
  }

  public redact(text: string, detections: DlpDetection[]): string {
    const redactDetections = detections.filter((d) => d.replacementText);
    if (redactDetections.length === 0) return text;

    // Sort detections by start index for safe merging
    const sorted = [...redactDetections].sort((a, b) => a.startIndex - b.startIndex);
    const merged: DlpDetection[] = [];

    for (const det of sorted) {
      if (merged.length === 0) {
        merged.push({ ...det });
        continue;
      }

      const last = merged[merged.length - 1];
      if (det.startIndex < last.endIndex) {
        // Overlap
        const originalEnd = last.endIndex;
        last.endIndex = Math.max(last.endIndex, det.endIndex);
        if (last.endIndex > originalEnd) {
          last.replacementText = '[REDACTED_MULTIPLE]';
        }
      } else {
        merged.push({ ...det });
      }
    }

    let result = text;
    // Process in reverse order so disjoint splits don't affect previous offsets
    for (let i = merged.length - 1; i >= 0; i--) {
      const det = merged[i];
      result = result.slice(0, det.startIndex) + det.replacementText + result.slice(det.endIndex);
    }
    return result;
  }

  private getReplacementText(
    ruleName: string,
    matchedString: string,
    _severity: SeverityLevel
  ): string {
    // Partial redaction for usability: sk-****123
    if (ruleName.includes('key') || ruleName.includes('token')) {
      if (matchedString.length > 8) {
        const prefix = matchedString.slice(0, 3);
        const suffix = matchedString.slice(-4);
        return `${prefix}****${suffix}`;
      }
    }

    // For CCs or SSNs
    if (ruleName === 'credit_card' && matchedString.length >= 12) {
      return `****-****-****-${matchedString.slice(-4)}`;
    }

    return `[REDACTED_${ruleName.toUpperCase()}]`;
  }
}
