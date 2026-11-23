#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Signing in with Microsoft Entra ID (lib/entra-oidc.ts, api/auth/sso/*,
# api/sso-config), against server.js in the appliance layout and fake-entra.js
# in place of login.microsoftonline.com: the settings and their secret, the
# way there and back, every check of the ID token, the role from the app
# roles, what an Entra account may not do, password sign-in for
# administrators only, and Entra switched off again.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
SRC=$BUILD
APP=/var/tmp/sso-app; D=/var/tmp/sso-data; FX=/var/tmp/sso-fake
PORT=3156; EPORT=4610; B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
W=$TESTS
T=11111111-2222-3333-4444-555555555555; C=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee; SECRET=s3cret-value
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
rm -rf $APP $D $FX; mkdir -p $APP $D $FX
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js
cp $REPO/{server.js,vnc-proxy.js} $APP/
[ -f $REPO/rdp-proxy.js ] && cp $REPO/rdp-proxy.js $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
$NODE $W/fake-entra.js $EPORT $FX > /var/tmp/sso-fake.log 2>&1 & E=$!
cd $APP
PORT=$PORT HTTPS_PORT=0 DATA_DIR=$D NODE_ENV=production XENMAN_ENTRA_AUTHORITY="http://127.0.0.1:$EPORT" \
  XENMAN_LOGIN_PAIR_LIMIT=100 XENMAN_LOGIN_IP_LIMIT=200 $NODE server.js > /var/tmp/sso-server.log 2>&1 & P=$!
cd /
trap 'kill $P $E 2>/dev/null' EXIT
for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done

BODY=/var/tmp/sso-body
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
req() { curl -s -o $BODY -w '%{http_code}' -b $1 -c $1 -X $2 $B$3 ${4:+$J -d "$4"}; }
login() { rm -f $1; req $1 POST /api/auth/login "{\"username\":\"$2\",\"password\":\"$3\"}"; }
audit() { $NODE -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval(process.argv[2]))' $D/audit.jsonl "$1"; }
wsauth() { $NODE $W/vnc-client.js "ws://127.0.0.1:$PORT/api/vnc-proxy" "$(grep xenman-auth $1 | awk '{print $7}')"; }
users() { $NODE -e 'const u=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(eval(process.argv[2]))' $D/users.json "$1"; }
# who signs in at the fake Entra ID: <oid> <upn> <roles, comma-separated>
as() { printf '{"oid":"%s","username":"%s","email":"%s","name":"%s","roles":[%s]}' "$1" "$2" "$2" "${2%@*}" "$(echo "$3" | sed -E 's/([^,]+)/"\1"/g')" > $FX/user.json; }
# sso <jar>: "Sign in with Microsoft" -> Entra -> back; prints where XenMan sends the browser at the end
sso() {
  local authz cb
  authz=$(curl -s -o /dev/null -w '%{redirect_url}' -b $1 -c $1 $B/api/auth/sso/start)
  cb=$(curl -s -o /dev/null -w '%{redirect_url}' "$authz")
  curl -s -o /dev/null -w '%{redirect_url}' -b $1 -c $1 "$cb" | sed "s#^$B##"
}
me() { req $1 GET /api/auth/me >/dev/null; field "[d.username,d.role,d.sso===true].join(' ')" < $BODY; }

A=/var/tmp/sso-a; O=/var/tmp/sso-o; U=/var/tmp/sso-u
login $A admin admin >/dev/null
req $A POST /api/auth/change-password '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
login $A admin Cobalt-Test-4242 >/dev/null
req $A POST /api/auth/users '{"username":"op1","password":"Maple-Root-0001","role":"operator"}' >/dev/null

echo "=== The settings ==="
check "off at first: no button" "200 false" "$(req $U GET /api/auth/sso) $(field d.enabled < $BODY)"
check "a tenant that is no GUID" 400 "$(req $A PUT /api/sso-config '{"enabled":false,"tenantId":"contoso"}')"
check "on without a secret: refused" 400 "$(req $A PUT /api/sso-config "{\"enabled\":true,\"tenantId\":\"$T\",\"clientId\":\"$C\",\"address\":\"$B\"}")"
check "an address that is not https" 400 "$(req $A PUT /api/sso-config "{\"enabled\":false,\"address\":\"http://xenman.example.org\"}")"
check "on, complete" "200 true true" \
  "$(req $A PUT /api/sso-config "{\"enabled\":true,\"tenantId\":\"$T\",\"clientId\":\"$C\",\"clientSecret\":\"$SECRET\",\"address\":\"$B\"}") $(field 'd.secretSet+" "+(d.clientSecret===undefined)' < $BODY)"
check "  the redirect URI as Entra needs it" "$B/api/auth/sso/callback" "$(field d.redirectUri < $BODY)"
check "  the secret not in sso.json in plain text" 0 "$(grep -c "$SECRET" $D/sso.json)"
check "  nor in the audit log" 0 "$(grep -c "$SECRET" $D/audit.jsonl)"
check "saved again without a secret: the secret kept" "200 true" \
  "$(req $A PUT /api/sso-config "{\"enabled\":true,\"tenantId\":\"$T\",\"clientId\":\"$C\",\"address\":\"$B\"}") $(field d.secretSet < $BODY)"
check "Test: the tenant found" "200 true" "$(req $A POST /api/sso-config "{\"action\":\"test\",\"tenantId\":\"$T\"}") $(field d.ok < $BODY)"
check "Test: a tenant Entra does not know" "false|Entra ID does not know this tenant (HTTP 400: AADSTS90002: Tenant not found.)" \
  "$(req $A POST /api/sso-config '{"action":"test","tenantId":"99999999-9999-9999-9999-999999999999"}' >/dev/null; field 'd.ok+"|"+d.detail' < $BODY)"
check "the sign-in page sees the button" "true false" "$(req $U GET /api/auth/sso >/dev/null; field 'd.enabled+" "+d.localAdminsOnly' < $BODY)"
login $O op1 Maple-Root-0001 >/dev/null
check "an operator may not see the settings" 403 "$(req $O GET /api/sso-config)"

echo "=== Signing in with Microsoft ==="
as 00000000-0000-0000-0000-0000000000a1 alice@contoso.example XenMan.Operator; rm -f $U
check "there and back: signed in" / "$(sso $U)"
check "  as an operator, an Entra account" "alice@contoso.example operator true" "$(me $U)"
check "  sent to Entra with PKCE (S256), the scopes and the redirect URI" "S256 openid profile email $B/api/auth/sso/callback $C" \
  "$(tail -1 $FX/authorize.log | $NODE -pe 'const q=JSON.parse(require("fs").readFileSync(0)); [q.code_challenge_method,q.scope,q.redirect_uri,q.client_id].join(" ")')"
check "  the account made: no password, linked by tenant and object id" "true|$T|00000000-0000-0000-0000-0000000000a1" \
  "$(users 'const a=u.find(x=>x.username==="alice@contoso.example"); [a.passwordHash==="",a.sso.tid,a.sso.oid].join("|")')"
check "  audited: made, signed in" "sso_user_created login" \
  "$(audit 'l.filter(e=>e.actor==="alice@contoso.example"&&e.outcome==="success").map(e=>e.action).join(" ")')"
check "  the console takes the session" true "$(r=$(wsauth $U); [[ "$r" != *401* ]] && echo true || echo "$r")"
as 00000000-0000-0000-0000-0000000000a1 alice@contoso.example XenMan.Viewer,XenMan.Admin; rm -f $U
check "the role follows Entra: admin now (the highest of two)" "/ alice@contoso.example admin true" "$(sso $U) $(me $U)"
check "  one account still, the change audited" "1 true" \
  "$(users 'u.filter(x=>x.username==="alice@contoso.example").length') $(audit 'l.some(e=>e.action==="login"&&/role now admin/.test(e.detail||""))')"

echo "=== What is refused ==="
fails() { rm -f $U; local r; r=$(sso $U); echo "$r $(req $U GET /api/auth/me)"; }
as 00000000-0000-0000-0000-0000000000c3 carol@contoso.example ""
check "no app role: no way in" "/login?sso=norole 401" "$(fails)"
check "  no account made" 0 "$(users 'u.filter(x=>x.username==="carol@contoso.example").length')"
as 00000000-0000-0000-0000-0000000000a1 alice@contoso.example XenMan.Operator
for f in bad-aud bad-iss bad-tid bad-nonce expired other-key unknown-kid; do
  touch $FX/$f; check "ID token with $f: not verified" "/login?sso=invalid 401" "$(fails)"; rm -f $FX/$f
done
touch $FX/token-400; check "the code refused at the token endpoint" "/login?sso=token 401" "$(fails)"; rm -f $FX/token-400
check "  Entra's reason audited" true "$(audit 'l.some(e=>e.action==="login"&&e.outcome==="failure"&&/AADSTS70008/.test(e.detail||""))')"
touch $FX/deny; check "Entra says no (not assigned)" "/login?sso=denied 401" "$(fails)"; rm -f $FX/deny
rm -f $U /var/tmp/sso-x
AUTHZ=$(curl -s -o /dev/null -w '%{redirect_url}' -b $U -c $U $B/api/auth/sso/start); CB=$(curl -s -o /dev/null -w '%{redirect_url}' "$AUTHZ")
check "back in another browser (no cookie): refused" "/login?sso=state" "$(curl -s -o /dev/null -w '%{redirect_url}' -b /var/tmp/sso-x -c /var/tmp/sso-x "$CB" | sed "s#^$B##")"
check "  in the browser that started it: signed in" / "$(curl -s -o /dev/null -w '%{redirect_url}' -b $U -c $U "$CB" | sed "s#^$B##")"
check "  the same answer once more: refused (the sign-in is used up)" "/login?sso=state" "$(curl -s -o /dev/null -w '%{redirect_url}' -b $U -c $U "$CB" | sed "s#^$B##")"
req $A POST /api/auth/users '{"username":"bob@contoso.example","password":"Maple-Root-0003","role":"viewer"}' >/dev/null
as 00000000-0000-0000-0000-0000000000b2 bob@contoso.example XenMan.Admin
check "a XenMan account of the same name is not taken over" "/login?sso=taken 401" "$(fails)"
check "  it stays as it was" "viewer false" "$(users 'const b=u.find(x=>x.username==="bob@contoso.example"); b.role+" "+Boolean(b.sso)')"

echo "=== What an Entra account cannot do ==="
as 00000000-0000-0000-0000-0000000000a1 alice@contoso.example XenMan.Operator; rm -f $U; sso $U >/dev/null
check "no password sign-in" 401 "$(login /var/tmp/sso-y alice@contoso.example whatever-it-is)"
check "no password to change" "400" "$(req $U POST /api/auth/change-password '{"currentPassword":"x","newPassword":"Another-Pass-9911"}')"
check "no reset link" "200 0" "$(req /var/tmp/sso-y POST /api/auth/forgot-password '{"usernameOrEmail":"alice@contoso.example"}') $(users 'u.filter(x=>x.resetToken).length')"
check "no XenMan second factor to set up" "409 true" "$(req $U POST /api/auth/totp '{"action":"start"}') $(field '/Entra ID/.test(d.error)' < $BODY)"
# Written straight into the file: through the API it would cover this test's administrator too.
echo '{"require":"all"}' > $D/twofactor.json
check "two-factor required for everyone: not of an Entra account" "200 false" "$(req $U GET /api/hosts) $(req $U GET /api/auth/me >/dev/null; field 'd.mustSetUpTotp===true' < $BODY)"
rm -f $D/twofactor.json
check "an administrator cannot change its role" 400 "$(req $A PUT /api/auth/users/alice@contoso.example '{"role":"viewer"}')"
check "  nor set a password" 400 "$(req $A PUT /api/auth/users/alice@contoso.example '{"newPassword":"Another-Pass-9911"}')"
check "the user list says Entra, nothing more (no object id, no hash)" "entra|true|true" \
  "$(req $A GET /api/auth/users >/dev/null; field 'const a=(d.users||d).find(x=>x.username==="alice@contoso.example"); [a.sso.provider,a.sso.oid===undefined,a.passwordHash===undefined].join("|")' < $BODY)"

echo "=== Password sign-in for administrators only ==="
check "switched on" "200 true" \
  "$(req $A PUT /api/sso-config "{\"enabled\":true,\"tenantId\":\"$T\",\"clientId\":\"$C\",\"address\":\"$B\",\"localAdminsOnly\":true}") $(field d.localAdminsOnly < $BODY)"
check "an operator's password: refused, told to use Microsoft" "403 true" "$(login $O op1 Maple-Root-0001) $(field d.ssoOnly < $BODY)"
check "an administrator's password still works" 200 "$(login $A admin Cobalt-Test-4242)"
check "the sign-in page knows" true "$(req /var/tmp/sso-z GET /api/auth/sso >/dev/null; field d.localAdminsOnly < $BODY)"

echo "=== Switched off ==="
check "off" 200 "$(req $A PUT /api/sso-config "{\"enabled\":false,\"tenantId\":\"$T\",\"clientId\":\"$C\",\"address\":\"$B\",\"localAdminsOnly\":true}")"
check "  the Entra account's session ends" 401 "$(req $U GET /api/auth/me)"
check "  its console too" true "$(r=$(wsauth $U); [[ "$r" == *401* ]] && echo true || echo "$r")"
check "  no way there or back" "404 404" "$(req /var/tmp/sso-z GET /api/auth/sso/start) $(req /var/tmp/sso-z GET '/api/auth/sso/callback?code=x&state=y')"
check "  passwords for everyone again" 200 "$(login $O op1 Maple-Root-0001)"
check "the settings changes audited" true "$(audit 'l.filter(e=>e.action==="sso_config_saved").length>=4')"

echo; echo "$pass passed, $fail failed"
exit $fail
