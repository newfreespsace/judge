#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
script="$repo/.github/scripts/deploy.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
export NSOJ_JUDGE_DEPLOY_ROOT="$fixture/opt"
export TEST_RESTARTS="$fixture/restarts"
export PATH="$fixture/bin:$PATH"
export CXXFLAGS=-g
unset CMAKE_POLICY_VERSION_MINIMUM
releases="$NSOJ_JUDGE_DEPLOY_ROOT/nsoj-judge-releases"
baseline="$releases/baseline"
active="$NSOJ_JUDGE_DEPLOY_ROOT/nsoj-judge"
commit=0123456789abcdef0123456789abcdef01234567
mkdir -p "$baseline" "$fixture/bin" "$fixture/source/scripts" "$fixture/source/native"
printf 'test configuration\n' > "$releases/config.yaml"
printf '{}\n' > "$fixture/source/package.json"
cp "$repo/scripts/install-dependencies.sh" "$fixture/source/scripts/"
cp "$repo/native/fmt-compat.h" "$fixture/source/native/"
tar -czf "$fixture/source.tar.gz" -C "$fixture/source" .
ln -s -- "$baseline" "$active"

cat > "$fixture/bin/sudo" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" == -* ]]; do shift; done
case "$1 $2" in
  '/usr/bin/pm2 restart')
    readlink -f "$NSOJ_JUDGE_DEPLOY_ROOT/nsoj-judge" >> "$TEST_RESTARTS"
    ;;
  '/usr/bin/pm2 pid')
    active=$(readlink -f "$NSOJ_JUDGE_DEPLOY_ROOT/nsoj-judge")
    if [[ "$active" == */baseline || "${TEST_START_FAIL:-}" != 1 ]]; then
      printf '12345\n'
    else
      printf '0\n'
    fi
    ;;
  'readlink -f')
    readlink -f "$NSOJ_JUDGE_DEPLOY_ROOT/nsoj-judge"
    ;;
  *) "$@" ;;
esac
SHIM

cat > "$fixture/bin/yarn" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'install --frozen-lockfile --production=false' ]]
[[ "${CMAKE_POLICY_VERSION_MINIMUM:-}" == 3.5 ]]
[[ "$CXXFLAGS" == "-g -include \"$PWD/native/fmt-compat.h\"" && -f native/fmt-compat.h ]]
[[ -f package.json && -L config.yaml && -r config.yaml ]]
[[ "${TEST_BUILD_FAIL:-}" != 1 ]]
SHIM

cat > "$fixture/bin/sleep" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "$fixture/bin/"*

echo 'Build failure leaves the original release online'
if TEST_BUILD_FAIL=1 bash "$script" "$commit" "$fixture/source.tar.gz"; then
  echo 'Expected the build to fail' >&2
  exit 1
fi
[[ "$(readlink "$active")" == "$baseline" && ! -e "$TEST_RESTARTS" ]]
[[ -z "$(find "$releases" -maxdepth 1 -name "$commit.*" -print -quit)" ]]

echo 'Startup failure rolls back and restarts the original release'
if TEST_START_FAIL=1 bash "$script" "$commit" "$fixture/source.tar.gz"; then
  echo 'Expected the new release to fail startup' >&2
  exit 1
fi
[[ "$(readlink "$active")" == "$baseline" ]]
mapfile -t restarts < "$TEST_RESTARTS"
[[ "${#restarts[@]}" == 2 && "${restarts[0]}" == "$releases/$commit."* && "${restarts[1]}" == "$baseline" ]]

echo 'Successful deployment activates the exact release and leaves the baseline available'
bash "$script" "$commit" "$fixture/source.tar.gz"
current=$(readlink "$active")
[[ "$current" == "$releases/$commit."* && -d "$baseline" ]]
[[ "$(readlink "$current/config.yaml")" == "$releases/config.yaml" ]]
[[ "$(tail -n 1 "$TEST_RESTARTS")" == "$current" ]]
