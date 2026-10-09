// Redacted checks: never print matched credential values or source lines.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["provider-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["google-api-identifier", /\bAIza[A-Za-z0-9_-]{35}\b/],
];
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
const sourceFiles = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
const sourceFindings = [];
const privatePaths = tracked.filter(path => /(?:^|\/)(?:\.env(?:\.|$)|[^/]*service.?account[^/]*\.json$)|\.(?:sqlite|p12|pem|key)$/.test(path));
for (const path of sourceFiles) {
  const bytes = readFileSync(resolve(root, path));
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [category, regex] of patterns) if (regex.test(text)) sourceFindings.push({ path, category });
}
const objects = git("rev-list", "--objects", "--all").split("\n").filter(Boolean);
const input = objects.map(line => line.split(" ")[0]).join("\n") + "\n";
const sizes = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
  cwd: root, input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
}).trim().split("\n");
const categories = Object.fromEntries(patterns.map(([category]) => [category, 0]));
let textBlobs = 0, skippedLargeBlobs = 0;
for (const line of sizes) {
  const [sha, type, size] = line.split(" ");
  if (type !== "blob") continue;
  if (Number(size) > 2 * 1024 * 1024) { skippedLargeBlobs++; continue; }
  const bytes = execFileSync("git", ["cat-file", "blob", sha], { cwd: root, maxBuffer: 3 * 1024 * 1024 });
  if (bytes.includes(0)) continue;
  textBlobs++;
  const text = bytes.toString("utf8");
  for (const [category, regex] of patterns) if (regex.test(text)) categories[category]++;
}
console.log(JSON.stringify({
  trackedFiles: tracked.length, candidateSourceFiles: sourceFiles.length, sourceFindings, trackedPrivatePaths: privatePaths,
  historyTextBlobsChecked: textBlobs, historyPatternMatches: categories, skippedLargeBlobs,
  caveat: "Pattern checks are not a comprehensive secret or privacy audit. Google client identifiers are not equivalent to admin credentials. Release only the standalone allowlisted package; do not publish parent history.",
}, null, 2));
if (sourceFindings.length || privatePaths.length || Object.values(categories).some(n => n)) process.exitCode = 1;
