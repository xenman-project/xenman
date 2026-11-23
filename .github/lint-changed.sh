#!/bin/bash
# lint-changed.sh <base commit>: ESLint on the files in src/ that changed since
# <base>, failing only where a file has more errors than it had at <base>.
# src/ carries older findings of the React rules; they are not to block every
# change, nor is a new one to hide among them.
set -euo pipefail
base=$(git merge-base "$1" HEAD)
mapfile -t files < <(git diff --name-only --diff-filter=ACMR "$base" HEAD -- 'src/*.ts' 'src/*.tsx')
if [ ${#files[@]} -eq 0 ]; then echo "no changed files in src/"; exit 0; fi
printf '%s\n' "${files[@]}"
tmp=${RUNNER_TEMP:-$(mktemp -d)}
npx eslint -f json "${files[@]}" > "$tmp/lint-head.json" || true

# The same files as they were at the base (those that were there).
git worktree add -q --detach "$tmp/lint-base" "$base"
trap 'git worktree remove --force "$tmp/lint-base"' EXIT
ln -s "$PWD/node_modules" "$tmp/lint-base/node_modules"
old=(); for f in "${files[@]}"; do [ -f "$tmp/lint-base/$f" ] && old+=("$f"); done
echo '[]' > "$tmp/lint-base.json"
if [ ${#old[@]} -gt 0 ]; then
  (cd "$tmp/lint-base" && npx eslint -f json "${old[@]}" > "$tmp/lint-base.json") || true
fi

node - "$PWD" "$tmp/lint-base" "$tmp/lint-head.json" "$tmp/lint-base.json" <<'JS'
const fs = require("fs");
const [head, baseDir, headFile, baseFile] = process.argv.slice(2);
const counts = (file, dir) => Object.fromEntries(
  JSON.parse(fs.readFileSync(file, "utf8")).map((r) => [r.filePath.slice(dir.length + 1), r]));
const now = counts(headFile, head), before = counts(baseFile, baseDir);
let worse = 0;
for (const [f, r] of Object.entries(now)) {
  const had = before[f]?.errorCount ?? 0;
  if (r.errorCount > had) {
    worse++;
    console.log(`\n${f}: ${r.errorCount} errors, ${had} before`);
    for (const m of r.messages.filter((m) => m.severity === 2)) console.log(`  ${m.line}:${m.column}  ${m.message}  ${m.ruleId ?? ""}`);
  } else if (r.errorCount) {
    console.log(`${f}: ${r.errorCount} older errors, none new`);
  }
}
if (worse) { console.log(`\n${worse} file(s) with new lint errors`); process.exit(1); }
console.log("no new lint errors");
JS
