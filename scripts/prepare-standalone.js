// Derive a portable, runtime-only lockfile from the audited workspace lock.
// Optionally stage the package with only its installed dependency closure for
// an isolated smoke test. This does not install packages or use credentials.
import { readFileSync, writeFileSync, cpSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { resolve, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(packageDir, "../..");
const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
const workspace = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const packages = { "": {
  name: manifest.name, version: manifest.version, license: manifest.license,
  dependencies: manifest.dependencies, bin: manifest.bin, engines: manifest.engines,
} };
const visited = new Set();
function resolveDependency(from, name, optional = false) {
  let cursor = from;
  for (;;) {
    const candidate = cursor === "." || !cursor ? `node_modules/${name}` : `${cursor}/node_modules/${name}`;
    if (workspace.packages[candidate] && !workspace.packages[candidate].link) return candidate;
    if (!cursor || cursor === ".") break;
    cursor = posix.dirname(cursor);
  }
  if (!optional) throw new Error(`Missing locked dependency ${name} from ${from}`);
  return null;
}
function include(path) {
  if (!path || visited.has(path)) return;
  visited.add(path);
  const source = structuredClone(workspace.packages[path]);
  delete source.dev; delete source.devOptional;
  if (source.resolved?.startsWith("http://package-firewall.replit.internal/npm/")) {
    source.resolved = source.resolved.replace("http://package-firewall.replit.internal/npm/", "https://registry.npmjs.org/");
  }
  packages[path] = source;
  for (const dependency of Object.keys(source.dependencies ?? {})) include(resolveDependency(path, dependency));
  for (const dependency of Object.keys(source.optionalDependencies ?? {})) include(resolveDependency(path, dependency, true));
  for (const dependency of Object.keys(source.peerDependencies ?? {})) {
    include(resolveDependency(path, dependency, Boolean(source.peerDependenciesMeta?.[dependency]?.optional)));
  }
}
for (const dependency of Object.keys(manifest.dependencies)) include(resolveDependency("", dependency));
const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };
writeFileSync(resolve(packageDir, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
const notices = [
  "# Runtime dependency notices",
  "",
  "ClearTask's MIT license applies only to ClearTask code. Dependencies retain",
  "their own licenses and copyright notices, supplied with the installed packages.",
  "This list is generated from the pinned standalone dependency closure; it is",
  "not a replacement for the dependencies' complete license text.",
  "",
  "| Locked package path | Version | Declared license |",
  "| --- | --- | --- |",
  ...Object.entries(packages).filter(([path]) => path).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, pkg]) => `| ${path} | ${pkg.version} | ${pkg.license ?? "Review package license"} |`),
  "",
];
writeFileSync(resolve(packageDir, "docs/DEPENDENCIES.md"), notices.join("\n"));
chmodSync(resolve(packageDir, "src/cli.js"), 0o755);

const stage = process.argv[2];
if (stage) {
  const target = resolve(stage);
  if (existsSync(target)) throw new Error("Choose an empty, new staging directory.");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of [".gitignore", "src", "test", "scripts", "docs", "examples", "package.json", "package-lock.json", "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"]) {
    cpSync(resolve(packageDir, file), resolve(target, file), { recursive: true });
  }
  for (const path of visited) {
    mkdirSync(dirname(resolve(target, path)), { recursive: true });
    cpSync(resolve(root, path), resolve(target, path), { recursive: true });
  }
  console.log(`Staged standalone package with ${visited.size} runtime dependencies. No app files or credentials copied.`);
} else console.log(`Generated portable lockfile for ${visited.size} runtime dependencies.`);
