#!/bin/bash
# The notes of a release: a line on what kind of release it is, its section of
# CHANGELOG.md, then the files with their checksums (.github/release-notes.md).
#
#   release-notes.sh <name> <xva sha256> <xenup sha256> <owner/repo> [beta]
#
# <name> is the tag (v1.2.3, v1.2.3-rc.1) -- a release candidate takes the
# section of the version it leads to -- or, on a dry run, a commit, which
# takes the newest section. No section, no notes: the release is not made.
set -euo pipefail
name=$1 xva=$2 xenup=$3 repo=$4 beta=${5:-}
here=$(cd "$(dirname "$0")" && pwd)

version=${name#v}; base=${version%%-*}
want=""; [[ "$name" =~ ^v[0-9] ]] && want=$base
changes=$(awk -v want="$want" '
  /^## \[/ { if (on) exit; if (want == "" || index($0, "## [" want "]") == 1) { on = 1; next } }
  on' "$here/../CHANGELOG.md" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')
if [ -z "$changes" ]; then
  echo "CHANGELOG.md has no section for ${want:-any version}: write it before releasing" >&2
  exit 1
fi

case "$name" in
  *-*) echo "> **Release candidate** for XenMan $base: for testing on a test pool, not for production. Please report problems as issues."; echo ;;
  *) if [ -n "$beta" ]; then echo "> **Beta.** XenMan is in daily use, but expect rough edges: try it on a test pool before you rely on it."; echo; fi ;;
esac
printf '%s\n\n' "$changes"
sed -e "s/{{TAG}}/$name/g" -e "s/{{XVA_SHA256}}/$xva/g" -e "s/{{XENUP_SHA256}}/$xenup/g" \
  -e "s#{{IMAGE}}#ghcr.io/$repo:$name#g" "$here/release-notes.md"
