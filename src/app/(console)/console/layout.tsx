import { InactivityGuard } from "@/components/inactivity-guard";

export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Typing into the VM counts as input, so working in a console keeps one signed in.
  return (
    <>
      {children}
      <InactivityGuard />
    </>
  );
}
