import { NextRequest, NextResponse } from "next/server";
import { verifyToken, COOKIE_NAME } from "@/lib/auth";

const PUBLIC_PATHS = [
  "/login",
  // Where signing out lands; there is no session left by then.
  "/signed-out",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/invite",
  "/invite",
  "/reset-password",
  // Confirming a network change from the new address, where nobody is logged in yet.
  "/network-confirm",
  "/api/appliance/network/confirm",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
  ) {
    return NextResponse.next();
  }

  // Allow Next.js internals and static assets
  if (pathname.startsWith("/_next/") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return denyAccess(request);
  }

  const payload = verifyToken(token);
  if (!payload) {
    return denyAccess(request);
  }

  // Logged in with the default password: only changing it is allowed.
  if (payload.pwc && !PASSWORD_CHANGE_PATHS.includes(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Password change required" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/change-password", request.url));
  }

  return NextResponse.next();
}

/** What a session that must change its password first may reach. */
const PASSWORD_CHANGE_PATHS = ["/change-password", "/api/auth/change-password", "/api/auth/me"];

function denyAccess(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // /api/update is left out on purpose. Next.js buffers every request that
  // passes through here and silently cuts the body at proxyClientMaxBodySize
  // (10 MB), and an update package is larger -- it arrived truncated and
  // unreadable. Raising that limit instead would let any unauthenticated
  // request make the appliance buffer that much before anyone checked who sent
  // it. The route does not need this gate: it requires an admin itself, which
  // is stricter than the valid session checked here, and streams the package
  // to disk under its own limit. /api/xen/import likewise: an XVA is passed on
  // to XenServer as it arrives, and the route checks the session itself.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/update$|api/xen/import$).*)"],
};
