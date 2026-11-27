#!/usr/bin/env bash
set -euo pipefail

commit=${1:?Pass the Git commit SHA}
archive=${2:?Pass the source archive path}
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]

base=${NSOJ_JUDGE_DEPLOY_ROOT:-/opt}
active="$base/nsoj-judge"
releases="$base/nsoj-judge-releases"
if [[ ! -L "$active" || ! -d "$active" || ! -r "$releases/config.yaml" ]]; then
  echo 'Prepare the release directories as described in the Judge README.' >&2
  exit 1
fi

exec 9>"$releases/.deploy.lock"
flock -x 9
previous=$(readlink -f -- "$active")
[[ "$previous" == "$releases/"* ]]

release=$(mktemp -d "$releases/$commit.XXXXXXXX")
switch_link="$release/.activate"
keep_release=false
cleanup() {
  rm -f -- "$switch_link"
  if ! $keep_release; then
    rm -rf -- "$release"
  fi
}
trap cleanup EXIT

activate() {
  ln -s -- "$1" "$switch_link"
  sudo -n mv -Tf -- "$switch_link" "$active"
}

restart() {
  sudo -H -n /usr/bin/pm2 restart nsoj-judge
}

running_in() {
  local pid cwd
  pid=$(sudo -H -n /usr/bin/pm2 pid nsoj-judge) || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  cwd=$(sudo -n readlink -f -- "/proc/$pid/cwd") || return 1
  [[ "$cwd" == "$1" ]] || return 1
  sleep 5
  [[ "$(sudo -H -n /usr/bin/pm2 pid nsoj-judge)" == "$pid" ]]
}

tar -xzf "$archive" -C "$release"
ln -s -- "$releases/config.yaml" "$release/config.yaml"
(cd "$release" && CMAKE_POLICY_VERSION_MINIMUM=3.5 yarn install --frozen-lockfile --production=false)

keep_release=true
activate "$release"
if restart && running_in "$release"; then
  printf 'Deployed %s\nPrevious release: %s\n' "$commit" "$previous"
  exit 0
fi

echo 'Judge did not stay running after the switch. Restoring the previous release.' >&2
activate "$previous"
if restart && running_in "$previous"; then
  echo 'Previous release restored.' >&2
else
  echo 'Previous release is selected. Check the PM2 process on the server.' >&2
fi
exit 1
