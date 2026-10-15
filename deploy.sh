#!/bin/sh
# Veröffentlicht den aktuellen Commit (HEAD) auf https://jobtracker.yann.es.
# Der Server "skynet" (siehe ~/.ssh/config) liefert /srv/jobtracker/html über den
# nginx-Container "jobtracker" aus, HTTPS macht Nginx Proxy Manager davor.
# Wie in .github/workflows/pages.yml landet die Build-Kennung nur im Deploy, nicht im Repo.
# Uncommittete Änderungen gehen bewusst nicht mit raus - deployt wird, was in git steht.
set -eu

cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git archive HEAD | tar -x -C "$tmp"
rm -rf "$tmp/.github" "$tmp/tests" "$tmp/deploy.sh" "$tmp/package.json"

stamp=$(TZ=Europe/Berlin git log -1 --format=%cd --date=format-local:'%Y.%m.%d %H:%M')
build="$stamp · $(git rev-parse --short=7 HEAD)"
sed -i '' "s|^const APP_BUILD = .*|const APP_BUILD = '$build';|" "$tmp/version.js"
grep -q "$build" "$tmp/version.js"

chmod -R u=rwX,go=rX "$tmp"
rsync -a --delete "$tmp/" skynet:/srv/jobtracker/html/
echo "Deployt: Build $build → https://jobtracker.yann.es"
