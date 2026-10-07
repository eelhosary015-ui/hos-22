#!/usr/bin/env bash
# REMO PRO ERP — PHASE 1 auth-gate regression.
#
# Proves that the development admin bypass is now EXPLICIT:
#   * DEV_AUTH_BYPASS=true  -> token-less /api request is granted (dev workflow unchanged)
#   * DEV_AUTH_BYPASS unset -> token-less /api/users and /api/system/diagnostics return 401
#   * a bogus bearer token  -> 403 INVALID_TOKEN
#
# It restarts the dev server on port 3000 and restores the original .env.flag.
set -u
cd "$(dirname "$0")/.." || exit 1
PORT=3000

stop_server() {
  local pid
  pid=$(netstat -ano | grep -E ":${PORT}\s+0\.0\.0\.0.*LISTENING" | awk '{print $5}' | head -1)
  if [ -n "${pid:-}" ]; then kill -9 "$pid" 2>/dev/null || taskkill //PID "$pid" //F >/dev/null 2>&1; sleep 2; fi
}

wait_up() {
  for _ in $(seq 1 40); do
    sleep 3
    if curl -s -m 3 -o /dev/null "http://127.0.0.1:${PORT}/api/health"; then return 0; fi
  done
  return 1
}

run_case() {
  local label="$1" want="$2"
  local code
  code=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/users")
  if [ "$code" = "$want" ]; then echo "  PASS  ${label} — /api/users => ${code}"; return 0
  else echo "  FAIL  ${label} — /api/users => ${code} (expected ${want})"; return 1; fi
}

fails=0
echo "=== CASE A: DEV_AUTH_BYPASS=true (dev convenience preserved) ==="
stop_server
DEV_AUTH_BYPASS=true NODE_ENV=development npx tsx server.ts > _audit/gate-a.log 2>&1 &
wait_up && run_case "bypass ON grants admin" 200 || { echo "  FAIL  server did not start (case A)"; fails=$((fails+1)); }

echo "=== CASE B: DEV_AUTH_BYPASS=false (secure by default) ==="
stop_server
DEV_AUTH_BYPASS=false NODE_ENV=development npx tsx server.ts > _audit/gate-b.log 2>&1 &
if wait_up; then
  run_case "bypass OFF rejects anonymous /api/users" 401 || fails=$((fails+1))
  d=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/system/diagnostics")
  [ "$d" = "401" ] && echo "  PASS  bypass OFF rejects anonymous /api/system/diagnostics — ${d}" || { echo "  FAIL  diagnostics => ${d} (expected 401)"; fails=$((fails+1)); }
  b=$(curl -s -m 8 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer bogus.token.here" "http://127.0.0.1:${PORT}/api/users")
  [ "$b" = "403" ] && echo "  PASS  bogus bearer token rejected — ${b}" || { echo "  FAIL  bogus token => ${b} (expected 403)"; fails=$((fails+1)); }
  h=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/health")
  [ "$h" = "200" ] && echo "  PASS  /api/health stays public — ${h}" || { echo "  FAIL  health => ${h}"; fails=$((fails+1)); }
else
  echo "  FAIL  server did not start (case B)"; fails=$((fails+1))
fi

echo "=== restore: restart server with the project .env ==="
stop_server
npx tsx server.ts > _audit/server.log 2>&1 &
wait_up && echo "  PASS  dev server back up on ${PORT}" || { echo "  FAIL  dev server did not come back"; fails=$((fails+1)); }

echo
[ "$fails" -eq 0 ] && echo "AUTH GATE: PASS" || echo "AUTH GATE: FAIL (${fails})"
exit "$fails"
