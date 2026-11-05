/**
 * The frame of the pages one meets signed out:
 * the product's name on petrol to the left, the form on white to the right.
 * On a phone the petrol shrinks to a strip above the form.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-white md:flex-row dark:bg-zinc-950">
      <div className="flex h-24 shrink-0 items-center justify-center bg-[var(--shell-bar)] md:h-auto md:flex-1">
        <span className="select-none text-4xl font-light tracking-tight text-white md:text-7xl">
          xenman
        </span>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center px-6 py-10">{children}</div>
        <footer className="pb-6 text-center text-xs text-zinc-400">
          XenServer Management
          {process.env.NEXT_PUBLIC_GIT_COMMIT && <span className="font-mono"> · {process.env.NEXT_PUBLIC_GIT_COMMIT}</span>}
        </footer>
      </div>
    </div>
  );
}

/** The heading above a form in the AuthShell: a title in petrol, a line beneath. */
export function AuthHeading({ title, subtitle }: { title: string; subtitle?: React.ReactNode }) {
  return (
    <div className="mb-7 text-center">
      <h1 className="text-[26px] font-normal text-[#005463] dark:text-white">{title}</h1>
      {subtitle && <p className="mt-1.5 text-xs text-zinc-500">{subtitle}</p>}
    </div>
  );
}
