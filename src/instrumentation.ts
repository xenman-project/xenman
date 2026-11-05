export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureJwtSecret, ensureAdminUser } = await import("@/lib/auth");
    ensureJwtSecret();
    ensureAdminUser();

    // A restart is a gap in the audit trail — mark it so the gap is explained.
    const { audit } = await import("@/lib/audit");
    audit({
      actor: "system",
      role: "-",
      ip: "-",
      category: "system",
      action: "server_started",
      outcome: "success",
      detail: `XenMan on Node ${process.version}, env=${process.env.NODE_ENV}`,
    });

    // Reminders about waiting security updates must go out even when nobody
    // opens the interface. Does nothing outside the appliance.
    const { startOsAlertChecker } = await import("@/lib/os-alerts");
    startOsAlertChecker();

    // The pools' trusted certificates: read now, so pools configured before
    // they were checked are taken over on their first connection (and the
    // console proxy in server.js finds the check on globalThis).
    const { allTrust } = await import("@/lib/host-trust");
    allTrust();

    // The stored passwords: files written before with default rights become
    // XenMan's alone, and passwords encrypted with an earlier key are
    // re-encrypted with the current one now rather than on first use.
    const fs = await import("fs");
    const path = await import("path");
    const dataDir = process.env.DATA_DIR || "/app/data";
    for (const f of ["hosts.json", "smtp.json", "users.json", ".jwt-secret", ".secret-key"]) {
      try {
        fs.chmodSync(path.join(dataDir, f), 0o600);
      } catch {
        // not there (yet), or not on a file system with modes
      }
    }
    const { loadHostsFromDisk } = await import("@/lib/host-storage");
    loadHostsFromDisk();
    const { loadSmtpConfig } = await import("@/lib/smtp-storage");
    loadSmtpConfig();

    // The audit log to a syslog collector, when one is set up.
    const { startSyslogForwarder } = await import("@/lib/syslog-forward");
    startSyslogForwarder();

    // Workload Balancing an update paused when XenMan stopped under it: on again.
    const { resumeWlbLeftPaused } = await import("@/lib/xen-update-jobs");
    void resumeWlbLeftPaused().catch(() => {});
  }
}
