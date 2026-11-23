#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Two-factor sign-in (lib/totp.ts, api/auth/login/totp, api/auth/totp, the
# policy), against server.js in the appliance layout: setting it up, the code
# after the password, recovery codes, wrong codes and the throttle, the policy
# that requires it, an administrator's reset -- and that nothing of the secret
# leaks. Codes come from totp-code.js, written apart from XenMan.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
SRC=$BUILD
APP=/var/tmp/tf-app; D=/var/tmp/tf-data
PORT=3152; B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
W=$TESTS
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
rm -rf $APP $D; mkdir -p $APP $D
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js
cp $REPO/{server.js,vnc-proxy.js} $APP/
[ -f $REPO/rdp-proxy.js ] && cp $REPO/rdp-proxy.js $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
cd $APP
PORT=$PORT HTTPS_PORT=0 DATA_DIR=$D NODE_ENV=production XENMAN_LOGIN_PAIR_BLOCK_MS=4000 $NODE server.js > /var/tmp/tf-server.log 2>&1 & P=$!
cd /
trap 'kill $P 2>/dev/null' EXIT
for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done

BODY=/var/tmp/tf-body
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
# req <cookie jar> <method> <path> [json] -> http code, body in $BODY
req() { curl -s -o $BODY -w '%{http_code}' -b $1 -c $1 -X $2 $B$3 ${4:+$J -d "$4"}; }
login() { rm -f $1; req $1 POST /api/auth/login "{\"username\":\"$2\",\"password\":\"$3\"}"; }
code() { $NODE $W/totp-code.js "$1" "${2:-0}"; }
audit() { $NODE -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval(process.argv[2]))' $D/audit.jsonl "$1"; }
wsauth() { $NODE $W/vnc-client.js "ws://127.0.0.1:$PORT/api/vnc-proxy" "$(grep xenman-auth $1 | awk '{print $7}')"; }

A=/var/tmp/tf-a; O=/var/tmp/tf-o
login $A admin admin >/dev/null
req $A POST /api/auth/change-password '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
login $A admin Cobalt-Test-4242 >/dev/null
req $A POST /api/auth/users '{"username":"op1","password":"Maple-Root-0001","role":"operator"}' >/dev/null
req $A POST /api/auth/users '{"username":"adm2","password":"Maple-Root-0002","role":"admin"}' >/dev/null

echo "=== setting it up ==="
check "off at first" "false 0 false" "$(req $A GET /api/auth/totp >/dev/null; field '[d.enabled,d.recoveryLeft,d.required].join(" ")' < $BODY)"
check "start: a key, an otpauth URI and a QR code" "200 true true true" \
  "$(req $A POST /api/auth/totp '{"action":"start"}') $(field '[/^([A-Z2-7]{4} )+[A-Z2-7]{4}$/.test(d.secret), d.uri.startsWith("otpauth://totp/XenMan%3Aadmin?secret="), d.qrSvg.startsWith("<svg")].join(" ")' < $BODY)"
SECRET=$(field 'd.secret.replace(/ /g,"")' < $BODY)
check "  the URI carries the key and XenMan's name" true "$(field 'd.uri.includes("secret='"$SECRET"'") && d.uri.includes("issuer=XenMan")' < $BODY)"
check "not on before it is confirmed" false "$(req $A GET /api/auth/totp >/dev/null; field d.enabled < $BODY)"
check "a wrong code does not confirm it" 400 "$(req $A POST /api/auth/totp '{"action":"confirm","code":"000000"}')"
check "the right one: on, ten recovery codes, once" "200 10 true" \
  "$(req $A POST /api/auth/totp "{\"action\":\"confirm\",\"code\":\"$(code $SECRET)\"}") $(field 'd.recoveryCodes.length+" "+d.recoveryCodes.every(c=>/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(c))' < $BODY)"
RC1=$(field 'd.recoveryCodes[0]' < $BODY); RC2=$(field 'd.recoveryCodes[1]' < $BODY)
check "on now, ten left" "true 10" "$(req $A GET /api/auth/totp >/dev/null; field 'd.enabled+" "+d.recoveryLeft' < $BODY)"
check "users.json: the key sealed, no plain key, recovery codes only as hashes" "true false false" \
  "$($NODE -pe 'const u=require("'$D'/users.json").find(u=>u.username==="admin"); [u.totp.secret.startsWith("enc"), JSON.stringify(u).includes("'$SECRET'"), JSON.stringify(u).includes("'$RC1'")].join(" ")')"
check "the user list says on, and nothing more" "true undefined undefined undefined" \
  "$(req $A GET /api/auth/users >/dev/null; field 'const u=(d.users||d).find(u=>u.username==="admin"); [u.totpEnabled,u.totp,u.recoveryCodes,u.totpSetup].map(String).join(" ")' < $BODY)"

echo "=== signing in ==="
check "the password alone: no session, the code is asked" "200 true" "$(login $A admin Cobalt-Test-4242) $(field d.totpRequired < $BODY)"
check "  no session cookie, a pending one" "0 1" "$(grep -c xenman-auth $A) $(grep -c xenman-2fa $A)"
check "  the pending cookie opens nothing" "401 401" "$(req $A GET /api/auth/me) $(req $A GET /api/hosts)"
check "  nor the console" true "$(r=$($NODE $W/vnc-client.js "ws://127.0.0.1:$PORT/api/vnc-proxy" "$(grep xenman-2fa $A | awk '{print $7}')"); [[ "$r" == *401* ]] && echo true || echo "$r")"
check "a wrong code" "401 The code is not right." "$(req $A POST /api/auth/login/totp '{"code":"000000"}') $(field d.error < $BODY)"
C=$(code $SECRET)
# The code confirmed the setup in this step already: one step ahead is allowed.
C1=$(code $SECRET 1)
check "the next step's code (one step of drift): signed in" "200 true" "$(req $A POST /api/auth/login/totp "{\"code\":\"$C1\"}") $(field d.success < $BODY)"
check "  a session, the pending cookie gone" "200 0" "$(req $A GET /api/auth/me) $(grep -c 'xenman-2fa.*[A-Za-z0-9]\{20\}' $A)"
check "  audited: login with two-factor code" true "$(audit 'l.filter(x=>x.action==="login"&&x.outcome==="success").pop().detail.includes("with two-factor code")')"
check "the same code again: refused (good once)" "401" "$(login $A admin Cobalt-Test-4242 >/dev/null; req $A POST /api/auth/login/totp "{\"code\":\"$C1\"}")"
check "a code two steps old: refused" "401" "$(req $A POST /api/auth/login/totp "{\"code\":\"$(code $SECRET -2)\"}")"

echo "=== recovery codes ==="
login $A admin Cobalt-Test-4242 >/dev/null
check "a recovery code signs in, nine left" "200 9" "$(req $A POST /api/auth/login/totp "{\"recoveryCode\":\"${RC1^^}\"}") $(field d.recoveryLeft < $BODY)"
check "  audited as such" true "$(audit 'l.filter(x=>x.action==="login"&&x.outcome==="success").pop().detail.includes("recovery code (9 left)")')"
login $A admin Cobalt-Test-4242 >/dev/null
check "the same one again: refused" 401 "$(req $A POST /api/auth/login/totp "{\"recoveryCode\":\"$RC1\"}")"
check "another one, without the dash: fine" 200 "$(req $A POST /api/auth/login/totp "{\"recoveryCode\":\"${RC2/-/}\"}")"
check "new codes need a code from the app" 400 "$(req $A POST /api/auth/totp '{"action":"regenerate","code":"000000"}')"
sleep 31  # a fresh step: the last one was used above
check "  with one: ten new" "200 10" "$(req $A POST /api/auth/totp "{\"action\":\"regenerate\",\"code\":\"$(code $SECRET 1)\"}") $(field d.recoveryCodes.length < $BODY)"
NEWRC=$(field 'd.recoveryCodes[0]' < $BODY)
# A full sign-in with the next step's code: it also clears the failures counted so far.
sleep 31
check "  and a sign-in with the app still works" 200 "$(login $A admin Cobalt-Test-4242 >/dev/null; req $A POST /api/auth/login/totp "{\"code\":\"$(code $SECRET 1)\"}")"

echo "=== wrong codes ==="
login $A admin Cobalt-Test-4242 >/dev/null
r=""; for i in 1 2 3 4; do r="$r$(req $A POST /api/auth/login/totp '{"code":"111111"}') "; done
check "four wrong codes" "401 401 401 401 " "$r"
check "the fifth: blocked, back to the password" "429 true" "$(req $A POST /api/auth/login/totp '{"code":"111111"}') $(field d.restart < $BODY)"
check "  a block: even the right password is refused for now" 429 "$(login $A admin Cobalt-Test-4242)"
check "  audited" true "$(audit 'l.some(x=>x.action==="login_blocked"&&x.actor==="admin")')"
sleep 5
check "after the block, with a recovery code" 200 "$(login $A admin Cobalt-Test-4242 >/dev/null; req $A POST /api/auth/login/totp "{\"recoveryCode\":\"$NEWRC\"}")"
check "an expired or forged pending cookie: sign in again" "401 true" "$(rm -f /var/tmp/tf-x; curl -s -o $BODY -w '%{http_code}' -b 'xenman-2fa=eyJhbGciOiJIUzI1NiJ9.e30.x' -X POST $B/api/auth/login/totp $J -d '{"code":"123456"}') $(field d.restart < $BODY)"

echo "=== switching it off ==="
check "wrong password: refused" 400 "$(req $A POST /api/auth/totp "{\"action\":\"disable\",\"password\":\"nope\",\"code\":\"$(code $SECRET)\"}")"
sleep 31
check "password and code: off" 200 "$(req $A POST /api/auth/totp "{\"action\":\"disable\",\"password\":\"Cobalt-Test-4242\",\"code\":\"$(code $SECRET 1)\"}")"
check "  the password alone signs in again" "200 undefined true" "$(login $A admin Cobalt-Test-4242) $(field 'd.totpRequired+" "+d.success' < $BODY)"
check "  users.json: nothing of it left" false "$($NODE -pe 'const u=require("'$D'/users.json").find(u=>u.username==="admin"); Boolean(u.totp||u.recoveryCodes||u.totpSetup)')"

echo "=== the policy ==="
check "an operator may not set it" 403 "$(login $O op1 Maple-Root-0001 >/dev/null; req $O POST /api/twofactor-policy '{"require":"admins"}')"
check "required for administrators" "200 admins" "$(req $A POST /api/twofactor-policy '{"require":"admins"}') $(field d.require < $BODY)"
check "  says who has not set it up" "2 1" "$(field 'd.withoutTotp.admins+" "+d.withoutTotp.others' < $BODY)"
check "  this admin's session: only setting it up" "true 403 307 /setup-2fa" \
  "$(req $A GET /api/auth/me >/dev/null; field d.mustSetUpTotp < $BODY) $(req $A GET /api/hosts) $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b $A $B/ | sed 's#http://127.0.0.1:'$PORT'##')"
check "  no console either" true "$(r=$(wsauth $A); [[ "$r" == *401* ]] && echo true || echo "$r")"
check "  the operator goes on" "200" "$(req $O GET /api/hosts)"
check "  the admin sets it up from that session" 200 "$(req $A POST /api/auth/totp '{"action":"start"}')"
SECRET=$(field 'd.secret.replace(/ /g,"")' < $BODY)
check "  confirmed: everything open again" "200 200" "$(req $A POST /api/auth/totp "{\"action\":\"confirm\",\"code\":\"$(code $SECRET)\"}") $(req $A GET /api/hosts)"
check "  and it cannot be switched off while required" 403 "$(req $A POST /api/auth/totp "{\"action\":\"disable\",\"password\":\"Cobalt-Test-4242\",\"code\":\"$(code $SECRET 1)\"}")"
check "the other admin, at the next sign-in: only setting it up" "200 true" "$(login /var/tmp/tf-a2 adm2 Maple-Root-0002) $(req /var/tmp/tf-a2 GET /api/auth/me >/dev/null; field d.mustSetUpTotp < $BODY)"
check "required for everyone: the operator too" "true" "$(req $A POST /api/twofactor-policy '{"require":"all"}' >/dev/null; req $O GET /api/auth/me >/dev/null; field d.mustSetUpTotp < $BODY)"
req $A POST /api/twofactor-policy '{"require":"none"}' >/dev/null
check "  audited" true "$(audit 'l.filter(x=>x.action==="twofactor_policy_saved").length===3')"

echo "=== an administrator resets it ==="
check "op1 sets it up" 200 "$(req $O POST /api/auth/totp '{"action":"start"}' >/dev/null; S2=$(field 'd.secret.replace(/ /g,"")' < $BODY); req $O POST /api/auth/totp "{\"action\":\"confirm\",\"code\":\"$(code $S2)\"}")"
check "an operator may not reset it" 403 "$(req $O PUT /api/auth/users/op1 '{"resetTotp":true}')"
check "the admin resets it: off, op1 signed out everywhere" "200 false 401" \
  "$(req $A PUT /api/auth/users/op1 '{"resetTotp":true}') $(req $A GET /api/auth/users >/dev/null; field 'String(Boolean((d.users||d).find(u=>u.username==="op1").totpEnabled))' < $BODY) $(req $O GET /api/auth/me)"
check "  op1 signs in with the password alone" "200 true" "$(login $O op1 Maple-Root-0001) $(field d.success < $BODY)"
check "  audited" true "$(audit 'l.some(x=>x.action==="user_totp_reset"&&x.target==="user op1")')"
# The link a forgotten-password mail carries, made here without the mail.
$NODE -e 'const f="'$D'/users.json",fs=require("fs");const l=JSON.parse(fs.readFileSync(f));const u=l.find(u=>u.username==="admin");u.resetToken="t".repeat(64);u.resetTokenExpiry=new Date(Date.now()+3600e3).toISOString();fs.writeFileSync(f,JSON.stringify(l,null,2))'
check "a new password through the mailed link leaves it on" "200 true"   "$(curl -s -o $BODY -w '%{http_code}' -X POST $B/api/auth/reset-password $J -d "{\"token\":\"$(printf 't%.0s' $(seq 64))\",\"password\":\"Cobalt-Test-5353\"}") $($NODE -pe 'Boolean(require("'$D'/users.json").find(u=>u.username==="admin").totp)')"
check "  and the code is still asked at sign-in" "200 true" "$(login $A admin Cobalt-Test-5353) $(field d.totpRequired < $BODY)"

echo "=== the audit log ==="
check "codes and secrets never written" "0 0" "$(grep -c "$SECRET" $D/audit.jsonl) $(grep -c "$RC2" $D/audit.jsonl)"
check "on, off, new codes, failed codes" true "$(audit '["totp_enabled","totp_disabled","recovery_codes_regenerated","login_totp"].every(a=>l.some(x=>x.action===a))')"

echo; echo "$pass passed, $fail failed"
exit $fail
