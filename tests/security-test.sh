#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The fixes of the security review (NEW-01/02, OPEN-01..04): plain HTTP sent to
# HTTPS, the cookie and HSTS; consoles for operators and admins only, and only
# where XenMan sent them; sign-ins that end on sign-out, a new password or the
# account's removal, with the role read live; reset links that die with a new
# password; the password rule. XenMan runs from server.js, as on the appliance.
set -u
export no_proxy='*' NO_PROXY='*'
SRC=$BUILD
APP=/var/tmp/sec-app; D=/var/tmp/sec-data; FX=/var/tmp/sec-fake
PORT=3175; HPORT=3176; XPORT=4495
IP=$(hostname -I | awk '{print $1}')
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
W=$TESTS
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/sec-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf $APP $D $FX; mkdir -p $APP $D $FX
echo normal > $FX/mode
"$NODE" $W/fake-xapi.js $XPORT $FX >> /var/tmp/sec-fake.log 2>&1 & FPID=$!
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js
cp $REPO/server.js $REPO/vnc-proxy.js $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
cd $APP
PORT=$PORT HTTPS_PORT=$HPORT HOSTNAME=0.0.0.0 DATA_DIR=$D NODE_ENV=production $NODE server.js >> /var/tmp/sec-server.log 2>&1 & P=$!
cd /
trap 'kill $P $FPID 2>/dev/null' EXIT
for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done

# login <user> <password> <jar>: signs in over loopback HTTP.
login() { curl -s -c "$3" -X POST $B/api/auth/login $J -d "{\"username\":\"$1\",\"password\":\"$2\"}"; }
me() { code -b "$1" $B/api/auth/me; }
A="-b /var/tmp/sec-admin"
login admin admin /var/tmp/sec-admin >/dev/null
curl -s -b /var/tmp/sec-admin -c /var/tmp/sec-admin -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
TOKEN=$(grep xenman-auth /var/tmp/sec-admin | awk '{print $7}')

echo "=== NEW-01: HTTPS only ==="
check "plain HTTP from the network: 308 to HTTPS" "308 https://$IP:$HPORT/login?x=1" \
  "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$IP:$PORT/login?x=1")"
check "  a forged transport header changes nothing" 308 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-xenman-transport: https' -H 'X-Forwarded-Proto: https' "http://$IP:$PORT/login")"
check "  nor does a Host header with a path in it" 400 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example/x' "http://$IP:$PORT/login")"
check "plain HTTP from this machine: served" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/login)"
check "HTTPS: HSTS" "max-age=31536000" \
  "$(curl -sk -D - -o /dev/null "https://$IP:$HPORT/login" | tr -d '\r' | awk -F': ' 'tolower($1)=="strict-transport-security"{print $2}')"
hdrs() { curl -sk -D - -o /dev/null "$1" | tr -d '\r' | awk -F': ' 'BEGIN{IGNORECASE=1} tolower($1)~/^(x-frame-options|content-security-policy|x-content-type-options|referrer-policy)$/{print tolower($1)"="$2}' | sort | tr '\n' ' '; }
SECH="content-security-policy=frame-ancestors 'none' referrer-policy=same-origin x-content-type-options=nosniff x-frame-options=DENY "
check "HTTPS: no frames, no sniffing, referrer kept in" "$SECH" "$(hdrs "https://$IP:$HPORT/login")"
check "  on an API answer as well" "$SECH" "$(hdrs "https://$IP:$HPORT/api/auth/me")"
check "  and on a static file" "$SECH" "$(hdrs "https://$IP:$HPORT/favicon.ico")"
check "  over plain HTTP from this machine too" "$SECH" "$(hdrs "$B/login")"
SC=$(curl -sk -D - -o /dev/null -X POST "https://$IP:$HPORT/api/auth/login" $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' | tr -d '\r' | grep -i '^set-cookie: xenman-auth')
check "  the cookie over HTTPS: Secure, HttpOnly, SameSite=Lax" "true true true" \
  "$(echo "$SC" | grep -qi '; secure' && echo true || echo false) $(echo "$SC" | grep -qi '; httponly' && echo true || echo false) $(echo "$SC" | grep -qi '; samesite=lax' && echo true || echo false)"
UP=(-H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" -H "Cookie: xenman-auth=$TOKEN")
check "a console WebSocket over plain HTTP from the network: refused" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${UP[@]}" "http://$IP:$PORT/api/vnc-proxy")"

echo "=== users and the pool ==="
for u in op1:operator vw1:viewer ad2:admin gone1:operator; do
  curl -s $A -X POST $B/api/auth/users $J -d "{\"username\":\"${u%%:*}\",\"password\":\"Pass-12345-xm\",\"role\":\"${u##*:}\"}" >/dev/null
  curl -s $A -X PUT $B/api/auth/users/${u%%:*} $J -d '{"pools":["pool1"]}' >/dev/null
done
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; S=$(field d.sessionRef < $BODY)
xen() { code -b "$1" -X POST $B/api/xen $J -d "{\"action\":\"$2\",\"sessionRef\":\"$3\"${4:+,$4}}"; }
session_of() { code -b "$1" -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; field d.sessionRef < $BODY; }

echo "=== NEW-02: consoles ==="
login vw1 Pass-12345-xm /var/tmp/sec-vw >/dev/null; VS=$(session_of /var/tmp/sec-vw)
check "a viewer may not open a console" 403 "$(xen /var/tmp/sec-vw vm_console "$VS" '"vmRef":"OpaqueRef:vm-1"')"
VT=$(grep xenman-auth /var/tmp/sec-vw | awk '{print $7}')
check "  nor reach the console proxy" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${UP[@]:0:8}" -H "Cookie: xenman-auth=$VT" "$B/api/vnc-proxy")"
check "the control domain's console only as the host console" 403 "$(xen /var/tmp/sec-admin vm_console "$S" '"vmRef":"OpaqueRef:dom0-1"')"
login op1 Pass-12345-xm /var/tmp/sec-op >/dev/null; OS=$(session_of /var/tmp/sec-op)
OT=$(grep xenman-auth /var/tmp/sec-op | awk '{print $7}')
check "an operator may" 200 "$(xen /var/tmp/sec-op vm_console "$OS" '"vmRef":"OpaqueRef:vm-1"')"
CURL=$(field d.url < $BODY)
WS="ws://127.0.0.1:$PORT/api/vnc-proxy?sessionId=$OS&consoleUrl="
enc() { "$NODE" -pe "encodeURIComponent(process.argv[1])" "$1"; }
check "  and gets the console handed out" "data RFB 003.008" "$("$NODE" $W/vnc-client.js "$WS$(enc "$CURL")" "$OT")"
N=$(grep -c CONNECT $FX/calls.log 2>/dev/null || echo 0)
check "another address on the same session: refused" "close 1008 Unknown console" "$("$NODE" $W/vnc-client.js "$WS$(enc "http://127.0.0.1:22/console?ref=x")" "$OT")"
check "  a console of another session: refused" "close 1008 Unknown console" "$("$NODE" $W/vnc-client.js "ws://127.0.0.1:$PORT/api/vnc-proxy?sessionId=$S&consoleUrl=$(enc "$CURL")" "$TOKEN")"
check "  nothing was connected" "$N" "$(grep -c CONNECT $FX/calls.log 2>/dev/null || echo 0)"
check "a malformed location: refused, the server lives on" "close 1008 Unknown console 200" \
  "$("$NODE" $W/vnc-client.js "${WS}%25%25%3A%2F%2F" "$OT") $(curl -s -o /dev/null -w '%{http_code}' $B/login)"

echo "=== OPEN-01: sign-ins ==="
login op1 Pass-12345-xm /var/tmp/sec-o1 >/dev/null; cp /var/tmp/sec-o1 /var/tmp/sec-o1copy
curl -s -b /var/tmp/sec-o1 -X POST $B/api/auth/logout >/dev/null
check "signed out: a copy of the cookie no longer works" 401 "$(me /var/tmp/sec-o1copy)"
login ad2 Pass-12345-xm /var/tmp/sec-ad2 >/dev/null
check "an admin" 200 "$(code -b /var/tmp/sec-ad2 $B/api/auth/users)"
curl -s $A -X PUT $B/api/auth/users/ad2 $J -d '{"role":"viewer"}' >/dev/null
check "  made viewer: at once no admin any more" "403 viewer" "$(code -b /var/tmp/sec-ad2 $B/api/auth/users) $(me /var/tmp/sec-ad2 >/dev/null; field d.role < $BODY)"
login gone1 Pass-12345-xm /var/tmp/sec-gone >/dev/null
curl -s $A -X DELETE $B/api/auth/users/gone1 >/dev/null
check "a deleted account's sign-in: gone" 401 "$(me /var/tmp/sec-gone)"
login op1 Pass-12345-xm /var/tmp/sec-c1 >/dev/null; login op1 Pass-12345-xm /var/tmp/sec-c2 >/dev/null
curl -s -b /var/tmp/sec-c1 -X POST $B/api/auth/change-password $J -d '{"currentPassword":"Pass-12345-xm","newPassword":"Maple-Root-2468"}' >/dev/null
check "a new password: the other sign-ins end, this one stays" "401 200" "$(me /var/tmp/sec-c2) $(me /var/tmp/sec-c1)"
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"newPassword":"Maple-Root-1357"}' >/dev/null
check "an administrator sets the password: all its sign-ins end" 401 "$(me /var/tmp/sec-c1)"
login op1 Maple-Root-1357 /var/tmp/sec-c3 >/dev/null
check "Sign Out Everywhere" "200 401" "$(code $A -X PUT $B/api/auth/users/op1 $J -d '{"signOut":true}') $(me /var/tmp/sec-c3)"
check "  audited" true "$(grep -q '"action":"user_signed_out".*op1' $D/audit*.jsonl && echo true || echo false)"
OLD=$("$NODE" -e '
  const c=require("crypto"), s=require("fs").readFileSync(process.argv[1],"utf8").trim();
  const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
  const h=b({alg:"HS256",typ:"JWT"}), p=b({sub:"admin",role:"admin",exp:Math.floor(Date.now()/1000)+3600});
  console.log(h+"."+p+"."+c.createHmac("sha256",s).update(h+"."+p).digest("base64url"));' $D/.jwt-secret)
check "a token from before (no sign-in id): not accepted" 401 "$(code -H "Cookie: xenman-auth=$OLD" $B/api/auth/me)"

echo "=== OPEN-03: reset links ==="
"$NODE" -e '
  const f=process.argv[1], fs=require("fs"), u=JSON.parse(fs.readFileSync(f,"utf8"));
  const o=u.find(x=>x.username==="op1"); o.resetToken="t".repeat(64); o.resetTokenExpiry=new Date(Date.now()+3600e3).toISOString();
  fs.writeFileSync(f, JSON.stringify(u,null,2));' $D/users.json
check "a reset link sent" 200 "$(code "$B/api/auth/reset-password?token=$(printf 't%.0s' $(seq 64))")"
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"newPassword":"Maple-Root-0001"}' >/dev/null
check "  the administrator sets a password: the link is dead" "400 400" \
  "$(code "$B/api/auth/reset-password?token=$(printf 't%.0s' $(seq 64))") $(code -X POST $B/api/auth/reset-password $J -d "{\"token\":\"$(printf 't%.0s' $(seq 64))\",\"password\":\"Hijack-Pass-9876\"}")"

echo "=== OPEN-04: the password rule ==="
pw() { code -b /var/tmp/sec-admin -X POST $B/api/auth/change-password $J -d "{\"currentPassword\":\"Cobalt-Test-4242\",\"newPassword\":\"$1\"}" >/dev/null; field d.error < $BODY; }
check "11 characters" "Password must be at least 12 characters" "$(pw Abcdefgh123)"
check "the user name in it" "Password must not contain the user name" "$(pw Admin-Lake-2026)"
check "a common one" "This password is too easy to guess" "$(pw 'Password1234!')"
check "12 good ones" 200 "$(code -b /var/tmp/sec-admin -X POST $B/api/auth/change-password $J -d '{"currentPassword":"Cobalt-Test-4242","newPassword":"River-Stone-77"}')"

echo "=== Review 2026-11: upgrades, cross-site requests, reset links ==="
HB="https://127.0.0.1:$HPORT"
login admin River-Stone-77 /var/tmp/sec-admin >/dev/null
UPG=(-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')
check "a WebSocket upgrade to anything but the console: answered and closed, not held (HTTPS)" 404 \
  "$(timeout 5 curl -sk -o /dev/null -w '%{http_code}' "${UPG[@]}" $HB/; true)"
check "  the same over plain HTTP" 404 "$(timeout 5 curl -s -o /dev/null -w '%{http_code}' "${UPG[@]}" $B/whatever; true)"
NEWU='{"username":"evil","password":"Xx-Ocean-123456","role":"admin"}'
check "another site's form, as text/plain (Sec-Fetch-Site: cross-site): refused" 403 \
  "$(code $A -X POST $B/api/auth/users -H 'Content-Type: text/plain' -H 'Sec-Fetch-Site: cross-site' -d "$NEWU")"
check "  from a sibling subdomain (same-site): refused" 403 \
  "$(code $A -X POST $B/api/auth/users -H 'Content-Type: text/plain' -H 'Sec-Fetch-Site: same-site' -d "$NEWU")"
check "  a browser without Sec-Fetch-Site, another Origin: refused" 403 \
  "$(code $A -X POST $B/api/auth/users $J -H 'Origin: https://evil.example' -d "$NEWU")"
check "  Origin null (sandboxed frame): refused" 403 "$(code $A -X POST $B/api/auth/users $J -H 'Origin: null' -d "$NEWU")"
check "  no account made" 0 "$(grep -c '"username": "evil"' $D/users.json)"
check "signing a browser in from another site: refused" 403 \
  "$(code -X POST $B/api/auth/login -H 'Content-Type: text/plain' -H 'Sec-Fetch-Site: cross-site' -d '{"username":"admin","password":"River-Stone-77"}')"
check "the update upload (outside the middleware), cross-site: refused" 403 \
  "$(code $A -X POST $B/api/update -H 'Sec-Fetch-Site: cross-site' -H 'Content-Type: application/octet-stream' --data-binary x)"
check "XenMan's own page (same-origin): works" 200 \
  "$(code $A -X POST $B/api/auth/users $J -H 'Sec-Fetch-Site: same-origin' -d '{"username":"carol","password":"Xx-Ocean-123456","role":"viewer","email":"carol@example.org"}')"
check "  an Origin that is this host: works" 200 \
  "$(code $A -X PUT $B/api/auth/users/carol $J -H "Origin: http://127.0.0.1:$PORT" -d '{"role":"operator"}')"
check "  reading from another site stays as it was (GET)" 200 "$(code $A $B/api/auth/me -H 'Sec-Fetch-Site: cross-site')"
curl -s -X POST $B/api/auth/forgot-password $J -d '{"usernameOrEmail":"carol"}' >/dev/null
check "a reset link asked for: in users.json" 1 "$(grep -c '"resetToken"' $D/users.json)"
check "  but not in the user list an administrator gets" "200 0" "$(code $A $B/api/auth/users) $(grep -c 'resetToken' $BODY)"

echo; echo "$pass passed, $fail failed"
exit $fail
