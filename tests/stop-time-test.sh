#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# How long XenMan's server.js takes to exit on SIGTERM -- what "systemctl stop
# xenman" waits for during an update -- idle and with connections open.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
SRC=$BUILD
APP=/var/tmp/stop-app
D=/var/tmp/stop-data
# The tree an update installs to /opt/xenman (appliance/build-update.sh).
rm -rf $APP $D; mkdir -p $APP $D
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js; cp $SRC/server.js $SRC/vnc-proxy.js $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
cd $APP
pass=0; fail=0
run() {
  PORT=3130 HTTPS_PORT=3131 DATA_DIR=$D NODE_ENV=production $NODE_BIN server.js > /var/tmp/stop-server.log 2>&1 & P=$!
  for _ in $(seq 120); do curl -s -o /dev/null http://127.0.0.1:3130/login && break; sleep 0.5; done
}
measure() {
  local t0=$(date +%s%N); kill -TERM $P
  for _ in $(seq 1200); do kill -0 $P 2>/dev/null || break; sleep 0.1; done
  local ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  echo "$1: $(kill -0 $P 2>/dev/null && echo "STILL RUNNING after ${ms} ms" || echo "exited after ${ms} ms")"
  # systemd waits 90 s before it kills; well under that is the point.
  if ! kill -0 $P 2>/dev/null && [ $ms -lt 5000 ]; then echo "  PASS  $1: within 5 s"; pass=$((pass+1)); else echo "  FAIL  $1: not within 5 s"; fail=$((fail+1)); fi
  kill -9 $P 2>/dev/null; wait $P 2>/dev/null
}
run; measure "idle"
run; exec 3<>/dev/tcp/127.0.0.1/3130; printf 'GET /login HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n' >&3; sleep 1
measure "plain HTTP keep-alive open"; exec 3>&-
run; (sleep 200 | openssl s_client -connect 127.0.0.1:3131 -quiet > /dev/null 2>&1 &); sleep 2
measure "HTTPS connection open"; pkill -f "openssl s_client" 2>/dev/null
grep -i "error" /var/tmp/stop-server.log | head -3

echo; echo "$pass passed, $fail failed"
exit $fail
