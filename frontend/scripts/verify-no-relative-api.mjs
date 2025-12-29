// frontend/scripts/verify-no-relative-api.mjs
// Fails the build if any frontend source file contains relative "/api/" usage like "/api/flights".
// This keeps the "one pipe only" rule: all calls must go through apiUrl(...) + VITE_API_BASE.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd()); // frontend/
const SRC = path.join(ROOT, "src");

const exts = new Set([".js", ".jsx", ".ts", ".tsx"]);
const hits = [];

function walk(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full);
    else if (it.isFile() && exts.has(path.extname(it.name))) scanFile(full);
  }
}

function scanFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");

  // Catch typical relative API usages:
  //  - "/api/..."
  //  - `/api/...`
  // We only care about RELATIVE "/api/" (leading slash), not full URLs.
  const patterns = [
    /["']\/api\/[^"']*/g,
    /`\/api\/[^`]*`/g
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      for (const s of m) {
        hits.push({ filePath, snippet: s.slice(0, 120) });
      }
      break;
    }
  }
}

function rel(p) {
  return path.relative(ROOT, p).replaceAll("\\\\", "/");
}

try {
  walk(SRC);
} catch (e) {
  console.error("❌ Guard failed while scanning source:", e?.message || e);
  process.exit(2);
}

if (hits.length > 0) {
  console.error("❌ Found relative /api/ usage in frontend code. Replace with apiUrl(...).");
  for (const h of hits.slice(0, 50)) {
    console.error(` - ${rel(h.filePath)} :: ${h.snippet}`);
  }
  if (hits.length > 50) console.error(` ...and ${hits.length - 50} more`);
  process.exit(1);
}

console.log("✅ No relative /api/ usage found.");
