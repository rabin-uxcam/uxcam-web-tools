#!/usr/bin/env node

/**
 * Checks if all "body" fields in log entries are unique.
 * Usage: node check-unique-bodies.js [file.json]
 * Defaults to session_and_replay_uploaded.json if no file is provided.
 */

const path = require("path");

const filePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "session_and_replay_uploaded.json");

const data = require(filePath);

const bodyCount = new Map();

for (const entry of data) {
  const body = entry.text?.body;
  if (!body) continue;
  bodyCount.set(body, (bodyCount.get(body) || 0) + 1);
}

const duplicates = [...bodyCount.entries()].filter(([, count]) => count > 1);

console.log(`Total entries: ${data.length}`);
console.log(`Unique bodies: ${bodyCount.size}`);

if (duplicates.length === 0) {
  console.log("\nAll bodies are unique.");
} else {
  console.log(`\nDuplicate bodies found: ${duplicates.length}\n`);
  for (const [body, count] of duplicates) {
    console.log(`  [${count}x] ${body}`);
  }
  process.exit(1);
}
