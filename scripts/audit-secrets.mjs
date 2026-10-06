import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url);
const ignoredDirectories = new Set([".git", "node_modules", ".codex"]);
const suspiciousPatterns = [
  { name: "JWT-like token", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "Bearer token", pattern: /Bearer\s+eyJ[A-Za-z0-9._-]{30,}/gi },
  { name: "LCN session cookie", pattern: /(?:XSRF-TOKEN|lcn_idiomas_session)=[A-Za-z0-9%._-]{30,}/g },
];

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory.pathname, entry.name);
    if (entry.isDirectory()) yield* files(new URL(`file://${path}/`));
    else yield path;
  }
}

const findings = [];
for await (const path of files(root)) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    continue;
  }

  for (const { name, pattern } of suspiciousPatterns) {
    if (pattern.test(content)) findings.push(`${relative(root.pathname, path)}: ${name}`);
    pattern.lastIndex = 0;
  }
}

if (findings.length > 0) {
  console.error("Potential credentials found in tracked workspace files:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log("Secret audit passed: no credential-like literals found.");
}
