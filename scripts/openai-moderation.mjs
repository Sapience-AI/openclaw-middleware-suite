#!/usr/bin/env node

/**
 * Calls the OpenAI Moderation API for a given text input.
 *
 * Usage:
 *   node --env-file=.env scripts/openai-moderation.mjs "text to moderate"
 *   echo "text to moderate" | node --env-file=.env scripts/openai-moderation.mjs
 */

import { OPENAI_API_KEY } from "./_metrics-env.mjs";

const input = process.argv[2] || await readStdin();

if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set. Add it to .env or set it as an environment variable.");
  process.exit(1);
}

if (!input) {
  console.error("Usage: node scripts/openai-moderation.mjs \"text to check\"");
  process.exit(1);
}

const res = await fetch("https://api.openai.com/v1/moderations", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
  body: JSON.stringify({ input }),
});

if (!res.ok) {
  console.error(`API error ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const data = await res.json();
const result = data.results[0];

console.log("\n--- Moderation Result ---");
console.log(`Flagged: ${result.flagged}`);
console.log("\nCategories:");
for (const [category, flagged] of Object.entries(result.categories)) {
  const score = result.category_scores[category].toFixed(4);
  console.log(`  ${flagged ? "[X]" : "[ ]"} ${category}: ${score}`);
}

// --- helpers ---

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(undefined);
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf.trim()));
  });
}
