#!/bin/bash
# The notes of a release: a line on what kind of release it is, its section of
# CHANGELOG.md, then the files with their checksums (.github/release-notes.md).
#
#   release-notes.sh <name> <xva sha256> <xenup sha256> <owner/repo> [beta]
#
# <name> is the tag (v1.2.3, v1.2.3-rc.1) -- a release candidate takes the
# section of the version it leads to -- or, on a dry run, a commit, which
# takes the newest section. No section, no notes: the release is not made.
#
# A release candidate after the first one opens with what is new since the
# one before: the entries of the section that were not in it, word for word,
# at the previous candidate's tag (needs the tags: fetch-depth 0).
set -euo pipefail
name=$1 xva=$2 xenup=$3 repo=$4 beta=${5:-}
here=$(cd "$(dirname "$0")" && pwd)

version=${name#v}; base=${version%%-*}
want=""; [[ "$name" =~ ^v[0-9] ]] && want=$base
# section: the version's section of a CHANGELOG.md on stdin, without blank lines around it.
section() {
  awk -v want="$want" '
    /^## \[/ { if (on) exit; if (want == "" || index($0, "## [" want "]") == 1) { on = 1; next } }
    on' | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
}
changes=$(section < "$here/../CHANGELOG.md")
if [ -z "$changes" ]; then
  echo "CHANGELOG.md has no section for ${want:-any version}: write it before releasing" >&2
  exit 1
fi

# The release candidate before this one, if any.
prev=""
if [[ "$name" =~ ^v[0-9.]+-rc\.([0-9]+)$ ]]; then
  n=${BASH_REMATCH[1]}
  for ((i = n - 1; i >= 1; i--)); do
    if git -C "$here" rev-parse -q --verify "refs/tags/v$base-rc.$i" >/dev/null; then prev="v$base-rc.$i"; break; fi
  done
fi
new=""
if [ -n "$prev" ]; then
  before=$(git -C "$here" show "$prev:CHANGELOG.md" 2>/dev/null | section || true)
  # Each entry is one line; keep the headings of the entries that are new.
  new=$(awk -v before="$before" '
    BEGIN { n = split(before, b, "\n"); for (i = 1; i <= n; i++) old[b[i]] = 1 }
    /^### / { head = $0; next }
    /^- / && !($0 in old) { if (head != shown) { if (shown != "") print ""; print head; shown = head } print }
  ' <<< "$changes")
fi

case "$name" in
  *-*) echo "> **Release candidate** for XenMan $base: for testing on a test pool, not for production. Please report problems as issues."; echo ;;
  *) if [ -n "$beta" ]; then echo "> **Beta.** XenMan is in daily use, but expect rough edges: try it on a test pool before you rely on it."; echo; fi ;;
esac
if [ -n "$prev" ]; then
  echo "## New in ${version#"$base"-} (since ${prev#"v$base"-})"
  echo
  if [ -n "$new" ]; then printf '%s\n\n' "${new//### /#### }"; else printf 'No changes to the notes; fixes from testing only.\n\n'; fi
  echo "## All changes in $base"
  echo
  printf '%s\n\n' "${changes//### /#### }"
else
  printf '%s\n\n' "$changes"
fi
sed -e "s/{{TAG}}/$name/g" -e "s/{{XVA_SHA256}}/$xva/g" -e "s/{{XENUP_SHA256}}/$xenup/g" \
  -e "s#{{IMAGE}}#ghcr.io/$repo:$name#g" "$here/release-notes.md"
