#!/bin/sh
# Runs INSIDE the image build (Dockerfile stage `test`), not on a Jenkins agent.
#
# Deliberately never fails: the `test-results` target has to export JUnit reports even
# for a red suite, otherwise Jenkins has nothing to publish and the build log is the only
# record of what broke. The verdict is written to $OUT/exit-code, and the Dockerfile's
# `verified` stage is what refuses to build an image from it.
set -u

OUT="${1:-/out}"
mkdir -p "${OUT}"
status=0
typecheck_status=0
lint_status=0
format_status=0
build_status=0

echo "== TypeScript"
if ! npm run typecheck; then
    typecheck_status=1
    status=1
fi

echo "== ESLint"
if ! npm run lint; then
    lint_status=1
    status=1
fi

echo "== Prettier"
if ! npm run format:check; then
    format_status=1
    status=1
fi

echo "== Produktions-Build"
if ! npm run build; then
    build_status=1
    status=1
fi

failures=$((typecheck_status + lint_status + format_status + build_status))
write_case() {
    check_name="$1"
    check_status="$2"
    printf '<testcase classname="quality" name="%s">' "${check_name}"
    if [ "${check_status}" -ne 0 ]; then
        printf '<failure message="%s failed">See the Docker build log.</failure>' "${check_name}"
    fi
    printf '%s\n' '</testcase>'
}

{
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '<testsuites name="quality" tests="4" failures="%s" errors="0">\n' "${failures}"
    printf '<testsuite name="quality" tests="4" failures="%s" errors="0">\n' "${failures}"
    write_case typecheck "${typecheck_status}"
    write_case lint "${lint_status}"
    write_case format "${format_status}"
    write_case build "${build_status}"
    printf '%s\n' '</testsuite>' '</testsuites>'
} > "${OUT}/quality.junit.xml"

echo "== Vitest"
if ! npx vitest run \
    --reporter=default \
    --reporter=junit \
    --outputFile.junit="${OUT}/tests.junit.xml"; then
    status=1
fi

if [ ! -s "${OUT}/tests.junit.xml" ]; then
    cat > "${OUT}/tests.junit.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="1" failures="1" errors="0">
  <testsuite name="vitest" tests="1" failures="1" errors="0">
    <testcase classname="vitest" name="test runner">
      <failure message="Vitest produced no JUnit report">See the Docker build log.</failure>
    </testcase>
  </testsuite>
</testsuites>
EOF
    status=1
fi

printf '%s\n' "${status}" > "${OUT}/exit-code"
echo "== Ergebnis: ${status} (0 = alles grün)"
exit 0
