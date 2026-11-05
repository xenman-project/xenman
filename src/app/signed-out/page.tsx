import Link from "next/link";

/**
 * Where signing out lands: a quiet
 * white page with the name top left, a word of goodbye, and the way back in.
 * Public, since by now there is no session.
 */
export default async function SignedOutPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  // Signed out by the inactivity timeout rather than by the user.
  const idle = (await searchParams).reason === "idle";
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <header className="px-4 py-3">
        <span className="select-none text-xl font-light tracking-tight text-zinc-900 dark:text-zinc-100">
          xenman
        </span>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          {idle ? "You were signed out due to inactivity." : "You are now signed out."}
        </h1>
        <p className="mt-4 text-[13px] text-zinc-700 dark:text-zinc-300">
          Thanks for using XenMan. See you again soon.
        </p>
        <Link
          href="/login"
          className="mt-5 rounded-full border border-[#05758a] px-5 py-1 text-xs text-[#05758a] transition-colors hover:bg-[#05758a] hover:text-white dark:border-[#7fd3e0] dark:text-[#7fd3e0] dark:hover:bg-[#7fd3e0] dark:hover:text-zinc-950"
        >
          Sign in again
        </Link>
      </main>
      <RelaxDrawing className="pointer-events-none absolute bottom-6 left-8 hidden h-44 w-56 text-zinc-900 sm:block dark:text-zinc-300" />
    </div>
  );
}

/**
 * A line drawing in the corner: someone off duty in a deck chair whose
 * backrest is a terminal window, coffee in hand, sun and sea beyond. The
 * filled shapes take the page's colour, so the figure sits in front of the
 * backrest in either theme.
 */
function RelaxDrawing({ className }: { className?: string }) {
  const fill = "fill-white dark:fill-zinc-950";
  return (
    <svg viewBox="60 30 300 230" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {/* Sun */}
      <circle cx="140" cy="64" r="9" fill="currentColor" stroke="none" />
      <path d="M140 38v10M140 80v12M112 64h12M156 64h18M121 45l7 7M152 76l8 8M121 84l7-7M153 51l9-9" />
      {/* Sea */}
      <path d="M192 128c10-4 18-4 28 0s18 4 28 0 18-4 28 0 16 3 24 0" />
      <path d="M232 152c10-4 18-4 28 0s18 4 28 0 18-4 28 0 14 3 22 0" />
      {/* Chair */}
      <path d="M80 236h212v7H80z" />
      <path d="M104 243l-3 9h12l2-9M262 243l2 9h12l-3-9" />
      {/* Backrest: a terminal window */}
      <path d="M70 132h92l40 104h-92z" />
      <path d="M74 143h92" />
      <path d="M77 135.5l4 2.5-4 2.5M84 141h5" />
      <path d="M88 180l-6 56" />
      {/* Body, knees up */}
      <path className={fill} d="M135 176C131 192 135 210 147 222C157 231 171 234 185 234H283C287 234 289 231 286 228L250 196C248 188 242 183 232 186C212 192 196 208 182 222C176 214 170 206 166 200C160 190 154 186 152 178Z" />
      <path d="M192 231c16-6 30-14 42-25" />
      <path d="M236 207l26 25" />
      {/* Arm and mug */}
      <path className={fill} d="M150 186c2 12 8 20 20 18 6-1 10-4 14-8" />
      <path className={fill} d="M178 186h14v14c0 3-2 5-5 5h-4c-3 0-5-2-5-5z" />
      <path d="M192 189c5 0 5 8 0 8" />
      <path d="M183 180c-2-3 2-5 0-8M188 180c-2-3 2-5 0-8" />
      {/* Head and hair */}
      <circle className={fill} cx="145" cy="163" r="10" />
      <path d="M134 168c-4-14 4-23 14-21 6 1 9 5 8 10-5-3-12-3-16 2-2 3-2 6-3 9z" fill="currentColor" />
      <path d="M148 172l1 6" />
    </svg>
  );
}
