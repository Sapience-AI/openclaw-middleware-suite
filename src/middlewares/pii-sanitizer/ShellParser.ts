/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

// @ts-expect-error bash-parser lacks type definitions
import parse from 'bash-parser';
import { logger } from '../../shared/Logger.js';

/**
 * Parses a bash command string and extracts only the explicit string literals (words/strings)
 * that the user typed. Ignores variable expansions, command names, command substitutions, etc.
 */
export class ShellParser {
  /**
   * Returns a list of discrete literal strings found in the bash command.
   */
  public extractLiterals(command: string): string[] {
    const literals: string[] = [];

    try {
      // Parse the bash command into an AST
      const ast = parse(command);

      // Basic AST Walk
      this.walk(ast, (node: any) => {
        // 'Word' node is typically a string argument.
        if (node.type === 'Word' && node.text) {
          literals.push(node.text);
        }

        // Also capture literal assignments like `export SECRET="my-key"`
        if (node.type === 'AssignmentWord' && node.text) {
          literals.push(node.text);
        }
      });
    } catch (e: any) {
      logger.warn('[ShellParser] Failed to parse command, falling back to full string scan', {
        error: e.message,
      });
      return [command]; // Fallback to raw string if parsing fails (e.g. invalid syntax)
    }

    return literals;
  }

  private walk(node: any, visitor: (n: any) => void) {
    if (!node) return;
    visitor(node);

    // Recursively walk properties of the node that might contain children
    const childrenKeys = ['commands', 'parts', 'suffix', 'prefix', 'else', 'cases', 'pattern'];

    for (const key of childrenKeys) {
      if (node[key]) {
        if (Array.isArray(node[key])) {
          node[key].forEach((child: any) => this.walk(child, visitor));
        } else {
          this.walk(node[key], visitor);
        }
      }
    }

    // Command specific structures
    if (node.type === 'If' && node.clause) this.walk(node.clause, visitor);
    if (node.type === 'If' && node.then) this.walk(node.then, visitor);
    if (node.type === 'For' && node.do) this.walk(node.do, visitor);
    if (node.type === 'While' && node.do) this.walk(node.do, visitor);
    if (node.type === 'Pipeline' && node.commands) {
      node.commands.forEach((c: any) => this.walk(c, visitor));
    }
    if (node.type === 'LogicalExpression') {
      this.walk(node.left, visitor);
      this.walk(node.right, visitor);
    }
  }
}
