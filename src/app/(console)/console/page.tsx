"use client";

import { useEffect, useRef, useCallback, useState, Suspense, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { downloadRdpFile, rdpAddress } from "@/lib/rdp-file";

/* ── Keysym constants (subset from noVNC) ── */
const KeySym = {
  XK_Return: 0xff0d,
  XK_Tab: 0xff09,
  XK_Escape: 0xff1b,
  XK_Shift_L: 0xffe1,
  XK_Control_L: 0xffe3,
  XK_Alt_L: 0xffe9,
  XK_Delete: 0xffff,
  XK_BackSpace: 0xff08,
  XK_F1: 0xffbe,
  XK_F2: 0xffbf,
  XK_F3: 0xffc0,
  XK_F4: 0xffc1,
  XK_F5: 0xffc2,
  XK_F6: 0xffc3,
  XK_F7: 0xffc4,
  XK_F8: 0xffc5,
  XK_F9: 0xffc6,
  XK_F10: 0xffc7,
  XK_F11: 0xffc8,
  XK_F12: 0xffc9,
};

/* ── Type text as simulated key events ── */
function typeTextViaKeys(rfb: RFBInstance, text: string) {
  for (const char of text) {
    if (char === "\n" || char === "\r") {
      rfb.sendKey(KeySym.XK_Return, "Enter", true);
      rfb.sendKey(KeySym.XK_Return, "Enter", false);
    } else if (char === "\t") {
      rfb.sendKey(KeySym.XK_Tab, "Tab", true);
      rfb.sendKey(KeySym.XK_Tab, "Tab", false);
    } else {
      // For standard characters, the X11 keysym equals the Unicode code point
      const keysym = char.codePointAt(0)!;
      rfb.sendKey(keysym, null, true);
      rfb.sendKey(keysym, null, false);
    }
  }
}

/* ── Types for the RFB instance ── */
interface RFBInstance {
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  sendCtrlAltDel(): void;
  clipboardPasteFrom(text: string): void;
  machineShutdown(): void;
  machineReboot(): void;
  machineReset(): void;
  disconnect(): void;
  focus(): void;
  scaleViewport: boolean;
  resizeSession: boolean;
  viewOnly: boolean;
  clipViewport: boolean;
  showDotCursor: boolean;
  qualityLevel: number;
  compressionLevel: number;
  /** XenMan's addition to noVNC: pictures received, rectangles per encoding. */
  stats: { updates: number; encodings: Record<string, number> };
  addEventListener(type: string, listener: (e: CustomEvent) => void): void;
  sendCredentials(creds: { password?: string }): void;
}

/* ── XenAPI power action helper ── */
type PowerActionKey =
  | "clean_shutdown"
  | "clean_reboot"
  | "suspend"
  | "hard_shutdown"
  | "hard_reboot";

async function xenPowerAction(
  host: string,
  port: string,
  useSsl: string,
  sessionRef: string,
  vmRef: string,
  action: PowerActionKey,
) {
  await fetch("/api/xen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "vm_power",
      host,
      port: Number(port),
      useSsl: useSsl === "true",
      sessionRef,
      vmRef,
      powerAction: action,
    }),
  });
}

/** The address the VM's tools report, for Remote Desktop; null while unknown. */
function useRdpTarget(
  host: string | null,
  port: string | null,
  useSsl: string,
  sessionRef: string | null,
  vmRef: string | null,
): { address: string; enabled: boolean | null } | null {
  const [target, setTarget] = useState<{ address: string; enabled: boolean | null } | null>(null);
  useEffect(() => {
    if (!host || !port || !sessionRef || !vmRef) return;
    let cancelled = false;
    fetch("/api/xen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "vm_guest_metrics", host, port: Number(port), useSsl: useSsl === "true", sessionRef, vmRef }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const address = data ? rdpAddress(data.ipAddresses || []) : null;
        if (!cancelled) setTarget(address ? { address, enabled: data.rdpEnabled ?? null } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, port, useSsl, sessionRef, vmRef]);
  return target;
}

/* ── Toolbar Component ── */
interface ConsoleViewer {
  actor: string;
  sessions: number;
  since: string;
  self: boolean;
}

/** How often the viewer list is refreshed. Presence changes are rare. */
const VIEWERS_POLL_MS = 10_000;

/**
 * Names the other people on this console.
 *
 * A XenServer console is shared: everyone connected sees the same screen and
 * every one of them can type. Today you notice a colleague is on the same VM
 * when the cursor starts moving by itself.
 *
 * Renders nothing when you are alone, so the toolbar stays quiet in the normal
 * case. Deliberately passive — no dialog, no blocking.
 */
function ViewerBadge({
  consoleUrl,
  connected,
}: {
  consoleUrl: string;
  connected: boolean;
}) {
  const [others, setOthers] = useState<ConsoleViewer[]>([]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(
          `/api/console/viewers?consoleUrl=${encodeURIComponent(consoleUrl)}`,
        );
        if (!res.ok) {
          // 403 while the proxy connection is still being established, or after
          // it dropped. Not worth surfacing — the next tick settles it.
          if (!cancelled) setOthers([]);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setOthers(
            ((data.viewers ?? []) as ConsoleViewer[]).filter((v) => !v.self),
          );
        }
      } catch {
        // Transient; keep whatever was last known.
      }
    };

    load();
    const interval = setInterval(load, VIEWERS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [consoleUrl, connected]);

  // While disconnected the last known list is stale rather than wrong; hiding it
  // here beats clearing it in the effect, which would cascade a render.
  if (!connected || others.length === 0) return null;

  const names = others
    .map((v) => (v.sessions > 1 ? `${v.actor} (${v.sessions}×)` : v.actor))
    .join(", ");

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 mr-2 rounded bg-amber-500/10 text-amber-400 text-xs"
      title={
        `Also connected to this console: ${names}.\n\n` +
        "Everyone connected sees the same screen and can type.\n" +
        "Only viewers going through XenMan are listed — someone using " +
        "XenCenter or a VNC client directly will not appear here."
      }
    >
      {/* Eye, drawn inline: this page pulls in no icon library. */}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span className="truncate max-w-[240px]">{names}</span>
    </div>
  );
}

/* ── Picture quality ── */
// Only Tight (and its JPEG) knows a quality; Hextile, ZRLE and Raw do not.
const QUALITY = {
  high: { label: "High", quality: 8, compression: 1 },
  medium: { label: "Medium", quality: 6, compression: 2 },
  low: { label: "Low — slow connections", quality: 3, compression: 6 },
} as const;
type Quality = keyof typeof QUALITY;
const QUALITY_KEY = "xenman-console-quality";

function savedQuality(): Quality {
  try {
    const q = window.localStorage.getItem(QUALITY_KEY);
    if (q && q in QUALITY) return q as Quality;
  } catch {
    // no storage: the default
  }
  return "medium";
}

function applyQuality(rfb: RFBInstance, q: Quality) {
  rfb.qualityLevel = QUALITY[q].quality;
  rfb.compressionLevel = QUALITY[q].compression;
}

const ENCODING_NAMES: Record<string, string> = {
  "0": "Raw",
  "1": "CopyRect",
  "2": "RRE",
  "5": "Hextile",
  "6": "Zlib",
  "7": "Tight",
  "16": "ZRLE",
  "21": "JPEG",
  "50": "H.264",
  "-260": "TightPNG",
};
const TIGHT = ["7", "21", "-260"];

/* ── Connection info: pictures per second, data rate, encoding ── */
interface ConnStats {
  fps: number;
  kbps: number;
  encoding: string;
  tight: boolean;
  /** Pictures per second over the last HISTORY seconds, oldest first. */
  history: number[];
}
const HISTORY = 30;

/** The last half minute's pictures per second as bars: stalls show as gaps. */
function FpsHistory({ history }: { history: number[] }) {
  const top = Math.max(10, ...history);
  return (
    <svg width={HISTORY * 2} height={12} className="inline-block align-middle" aria-hidden="true">
      {history.map((v, i) => {
        const h = v > 0 ? Math.max(1, Math.round((v / top) * 12)) : 0;
        return <rect key={i} x={(HISTORY - history.length + i) * 2} y={12 - h} width={1.5} height={h} fill="currentColor" />;
      })}
      <line x1={0} y1={11.5} x2={HISTORY * 2} y2={11.5} stroke="currentColor" strokeOpacity={0.25} />
    </svg>
  );
}

function useConnStats(rfb: RFBInstance | null, bytes: RefObject<number>): ConnStats | null {
  const [stats, setStats] = useState<ConnStats | null>(null);
  useEffect(() => {
    if (!rfb?.stats) return;
    let last = { at: Date.now(), updates: rfb.stats.updates, bytes: bytes.current, encodings: { ...rfb.stats.encodings } };
    let tight = false;
    const timer = setInterval(() => {
      const now = { at: Date.now(), updates: rfb.stats.updates, bytes: bytes.current, encodings: { ...rfb.stats.encodings } };
      const secs = Math.max(0.001, (now.at - last.at) / 1000);
      // The encoding most rectangles came in lately, CopyRect aside.
      let encoding = "";
      let most = 0;
      for (const [enc, n] of Object.entries(now.encodings)) {
        const recent = n - (last.encodings[enc] ?? 0);
        if (enc !== "1" && recent > most) {
          most = recent;
          encoding = ENCODING_NAMES[enc] ?? `encoding ${enc}`;
        }
        if (TIGHT.includes(enc)) tight = true;
      }
      const fps = Math.round((now.updates - last.updates) / secs);
      setStats((prev) => ({
        fps,
        kbps: Math.round((now.bytes - last.bytes) / 1024 / secs),
        encoding: encoding || prev?.encoding || "",
        tight,
        history: [...(prev?.history ?? []), fps].slice(-HISTORY),
      }));
      last = now;
    }, 1000);
    return () => clearInterval(timer);
  }, [rfb, bytes]);
  return rfb ? stats : null;
}

/* ── What XenMan's console proxy measures for this connection ── */
interface ProxyStats {
  /** "on", "switched off", "off: <why>" -- asking the host ahead for pictures. */
  ahead: string;
  /** Requests XenMan sent ahead per second. */
  aheadPerSec: number;
  /** How long the host takes to answer a request, in ms. */
  hostMs: number | null;
  /** Round trip XenMan <-> this browser (through the NetScaler), in ms. */
  netMs: number | null;
  /** The longest of those lately. */
  netMaxMs: number | null;
  /** The most that waited at XenMan for this browser lately, in KB. */
  queuedKB: number;
}

function useProxyStats(rfb: RFBInstance | null, statsId: RefObject<string>, enabled: boolean): ProxyStats | null {
  const [stats, setStats] = useState<ProxyStats | null>(null);
  useEffect(() => {
    if (!rfb || !enabled) return;
    let last: { at: number; ahead: number } | null = null;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/console/stats?id=${encodeURIComponent(statsId.current)}`, { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        const now = { at: Date.now(), ahead: Number(d.aheadRequests) || 0 };
        setStats({
          ahead: String(d.ahead ?? ""),
          aheadPerSec: last ? Math.round((now.ahead - last.ahead) / Math.max(0.001, (now.at - last.at) / 1000)) : 0,
          hostMs: d.hostMs ?? null,
          netMs: d.netMs ?? null,
          netMaxMs: d.netMaxMs ?? null,
          queuedKB: Number(d.queuedKB) || 0,
        });
        last = now;
      } catch {
        // the next round
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [rfb, statsId, enabled]);
  return rfb && enabled ? stats : null;
}

function ConsoleToolbar({
  rfb,
  label,
  connected,
  host,
  port,
  useSsl,
  sessionRef,
  vmRef,
  consoleUrl,
  bytes,
  statsId,
}: {
  bytes: RefObject<number>;
  statsId: RefObject<string>;
  rfb: RFBInstance | null;
  label: string;
  connected: boolean;
  host: string | null;
  port: string | null;
  useSsl: string;
  sessionRef: string | null;
  vmRef: string | null;
  consoleUrl: string;
}) {
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [scaled, setScaled] = useState(true);
  const [clipText, setClipText] = useState("");
  const [showClipboard, setShowClipboard] = useState(false);
  const [powerLoading, setPowerLoading] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [quality, setQuality] = useState<Quality | null>(null);
  const stats = useConnStats(rfb, bytes);
  const proxy = useProxyStats(rfb, statsId, showInfo);
  const rdp = useRdpTarget(host, port, useSsl, sessionRef, vmRef);

  const canPower = !!(host && port && sessionRef && vmRef);

  // One menu at a time: the clipboard panel has a state of its own, so opening
  // Keys, View or Power closes it too.
  const toggleMenu = (name: string) => {
    setShowClipboard(false);
    setMenuOpen((open) => (open === name ? null : name));
  };

  const closeMenus = () => {
    setMenuOpen(null);
    setShowClipboard(false);
  };

  const sendKeys = (keys: { sym: number; code: string }[]) => {
    if (!rfb) return;
    keys.forEach((k) => rfb.sendKey(k.sym, k.code, true));
    [...keys].reverse().forEach((k) => rfb.sendKey(k.sym, k.code, false));
    rfb.focus();
    closeMenus();
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
    closeMenus();
  };

  const toggleScale = () => {
    if (!rfb) return;
    const next = !scaled;
    setScaled(next);
    rfb.scaleViewport = next;
    rfb.resizeSession = next;
    closeMenus();
  };

  const toggleViewOnly = () => {
    if (!rfb) return;
    const next = !viewOnly;
    setViewOnly(next);
    rfb.viewOnly = next;
    closeMenus();
  };

  const toggleInfo = () => {
    setShowInfo(!showInfo);
    closeMenus();
  };

  const chooseQuality = (q: Quality) => {
    setQuality(q);
    try {
      window.localStorage.setItem(QUALITY_KEY, q);
    } catch {
      // kept for this window only
    }
    if (rfb) applyQuality(rfb, q);
    closeMenus();
  };

  const pasteClipboard = () => {
    if (!rfb || !clipText) return;
    typeTextViaKeys(rfb, clipText);
    rfb.focus();
    setShowClipboard(false);
  };

  // block: inside a menu's wrapper an inline button sits on the text baseline,
  // a few pixels below a button that is a direct item of the bar (Remote Desktop).
  const menuBtnClass =
    "block px-2.5 py-1 text-xs hover:bg-zinc-700 rounded transition-colors relative whitespace-nowrap";
  const activeBtnClass =
    "block px-2.5 py-1 text-xs bg-zinc-700 rounded transition-colors relative whitespace-nowrap";
  const dropdownClass =
    "absolute top-full left-0 mt-1 bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 min-w-[180px] z-50";
  const dropItemClass =
    "w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 transition-colors flex items-center justify-between";

  return (
    <div
      className="flex items-center bg-zinc-900 text-zinc-300 border-b border-zinc-800 select-none"
      style={{ height: 32 }}
      onMouseLeave={() => setMenuOpen(null)}
    >
      {/* Status indicator + label */}
      <div className="flex items-center gap-2 px-3 border-r border-zinc-800 h-full">
        <div
          className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`}
        />
        <span className="text-xs font-medium truncate max-w-[200px]">
          {label}
        </span>
      </div>

      {/* Send Keys menu */}
      <div className="relative">
        <button
          className={menuOpen === "keys" ? activeBtnClass : menuBtnClass}
          onClick={() => toggleMenu("keys")}
        >
          Keys
        </button>
        {menuOpen === "keys" && (
          <div className={dropdownClass}>
            <button
              className={dropItemClass}
              onClick={() => rfb?.sendCtrlAltDel()}
            >
              Ctrl + Alt + Del
              <kbd className="text-[10px] text-zinc-500 ml-2">Power</kbd>
            </button>
            <button
              className={dropItemClass}
              onClick={() => sendKeys([{ sym: KeySym.XK_Tab, code: "Tab" }])}
            >
              Tab
            </button>
            <button
              className={dropItemClass}
              onClick={() =>
                sendKeys([{ sym: KeySym.XK_Escape, code: "Escape" }])
              }
            >
              Esc
            </button>
            <button
              className={dropItemClass}
              onClick={() =>
                sendKeys([
                  { sym: KeySym.XK_Control_L, code: "ControlLeft" },
                  { sym: KeySym.XK_Alt_L, code: "AltLeft" },
                  { sym: KeySym.XK_F1, code: "F1" },
                ])
              }
            >
              Ctrl + Alt + F1
              <kbd className="text-[10px] text-zinc-500 ml-2">TTY1</kbd>
            </button>
            <button
              className={dropItemClass}
              onClick={() =>
                sendKeys([
                  { sym: KeySym.XK_Control_L, code: "ControlLeft" },
                  { sym: KeySym.XK_Alt_L, code: "AltLeft" },
                  { sym: KeySym.XK_F2, code: "F2" },
                ])
              }
            >
              Ctrl + Alt + F2
              <kbd className="text-[10px] text-zinc-500 ml-2">TTY2</kbd>
            </button>
            <button
              className={dropItemClass}
              onClick={() =>
                sendKeys([
                  { sym: KeySym.XK_Control_L, code: "ControlLeft" },
                  { sym: KeySym.XK_Alt_L, code: "AltLeft" },
                  { sym: KeySym.XK_F7, code: "F7" },
                ])
              }
            >
              Ctrl + Alt + F7
              <kbd className="text-[10px] text-zinc-500 ml-2">GUI</kbd>
            </button>
            <div className="border-t border-zinc-700 my-1" />
            {([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const).map((n) => {
              const sym = KeySym[`XK_F${n}` as keyof typeof KeySym];
              return (
                <button
                  key={n}
                  className={dropItemClass}
                  onClick={() => sendKeys([{ sym, code: `F${n}` }])}
                >
                  F{n}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Clipboard */}
      <div className="relative">
        <button
          className={showClipboard ? activeBtnClass : menuBtnClass}
          onClick={() => {
            setShowClipboard(!showClipboard);
            setMenuOpen(null);
          }}
        >
          Clipboard
        </button>
        {showClipboard && (
          <div
            className="absolute top-full left-0 mt-1 bg-zinc-800 border border-zinc-700 rounded shadow-xl p-2 z-50"
            style={{ width: 280 }}
          >
            <textarea
              className="w-full h-20 bg-zinc-900 text-zinc-200 text-xs p-2 rounded border border-zinc-700 resize-none focus:outline-none focus:border-zinc-500"
              placeholder="Paste text here to send to VM..."
              value={clipText}
              onChange={(e) => setClipText(e.target.value)}
            />
            <div className="flex gap-1.5 mt-1.5">
              <button
                className="flex-1 px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
                onClick={pasteClipboard}
              >
                Send to VM
              </button>
              <button
                className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
                onClick={() => {
                  setClipText("");
                  setShowClipboard(false);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>

      {/* View / Settings menu */}
      <div className="relative">
        <button
          className={menuOpen === "view" ? activeBtnClass : menuBtnClass}
          onClick={() => toggleMenu("view")}
        >
          View
        </button>
        {menuOpen === "view" && (
          <div className={dropdownClass}>
            <button className={dropItemClass} onClick={toggleFullscreen}>
              Fullscreen
              <kbd className="text-[10px] text-zinc-500 ml-2">F11</kbd>
            </button>
            <button className={dropItemClass} onClick={toggleScale}>
              Scale to fit
              <span
                className={`ml-2 text-[10px] ${scaled ? "text-emerald-400" : "text-zinc-500"}`}
              >
                {scaled ? "ON" : "OFF"}
              </span>
            </button>
            <button className={dropItemClass} onClick={toggleViewOnly}>
              View only
              <span
                className={`ml-2 text-[10px] ${viewOnly ? "text-emerald-400" : "text-zinc-500"}`}
              >
                {viewOnly ? "ON" : "OFF"}
              </span>
            </button>
            <button className={dropItemClass} onClick={toggleInfo}>
              Connection info
              <span className={`ml-2 text-[10px] ${showInfo ? "text-emerald-400" : "text-zinc-500"}`}>
                {showInfo ? "ON" : "OFF"}
              </span>
            </button>
            {stats?.tight && (
              <>
                <div className="border-t border-zinc-700 my-1" />
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-zinc-500">Picture quality</div>
                {(Object.keys(QUALITY) as Quality[]).map((q) => (
                  <button key={q} className={dropItemClass} onClick={() => chooseQuality(q)}>
                    {QUALITY[q].label}
                    {(quality ?? savedQuality()) === q && <span className="ml-2 text-[10px] text-emerald-400">●</span>}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Power menu */}
      {canPower && (
        <div className="relative">
          <button
            className={menuOpen === "power" ? activeBtnClass : menuBtnClass}
            onClick={() => toggleMenu("power")}
          >
            {powerLoading ? `${powerLoading}...` : "Power"}
          </button>
          {menuOpen === "power" && (
            <div className={dropdownClass}>
              <button
                className={dropItemClass}
                disabled={!!powerLoading}
                onClick={async () => {
                  setPowerLoading("Shutdown");
                  closeMenus();
                  await xenPowerAction(host!, port!, useSsl, sessionRef!, vmRef!, "clean_shutdown");
                  setPowerLoading(null);
                }}
              >
                Shutdown
              </button>
              <button
                className={dropItemClass}
                disabled={!!powerLoading}
                onClick={async () => {
                  setPowerLoading("Reboot");
                  closeMenus();
                  await xenPowerAction(host!, port!, useSsl, sessionRef!, vmRef!, "clean_reboot");
                  setPowerLoading(null);
                }}
              >
                Reboot
              </button>
              <button
                className={dropItemClass}
                disabled={!!powerLoading}
                onClick={async () => {
                  setPowerLoading("Suspend");
                  closeMenus();
                  await xenPowerAction(host!, port!, useSsl, sessionRef!, vmRef!, "suspend");
                  setPowerLoading(null);
                }}
              >
                Suspend
              </button>
              <div className="border-t border-zinc-700 my-1" />
              <button
                className={`${dropItemClass} text-red-400 hover:text-red-300`}
                disabled={!!powerLoading}
                onClick={async () => {
                  setPowerLoading("Force Shutdown");
                  closeMenus();
                  await xenPowerAction(host!, port!, useSsl, sessionRef!, vmRef!, "hard_shutdown");
                  setPowerLoading(null);
                }}
              >
                Force Shutdown
              </button>
              <button
                className={`${dropItemClass} text-red-400 hover:text-red-300`}
                disabled={!!powerLoading}
                onClick={async () => {
                  setPowerLoading("Force Reboot");
                  closeMenus();
                  await xenPowerAction(host!, port!, useSsl, sessionRef!, vmRef!, "hard_reboot");
                  setPowerLoading(null);
                }}
              >
                Force Reboot
              </button>
            </div>
          )}
        </div>
      )}

      {/* Remote Desktop, as XenCenter's "Switch to Remote Desktop" */}
      {rdp && (
        <button
          className={menuBtnClass}
          onClick={() => {
            downloadRdpFile(label.replace(/^Console:\s*/, ""), rdp.address);
            closeMenus();
          }}
          title={
            `Remote Desktop to ${rdp.address} — opens in this computer's Remote Desktop client.` +
            (rdp.enabled === false ? "\nThe VM's tools report Remote Desktop as switched off." : "")
          }
        >
          Remote Desktop
        </button>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {showInfo && connected && stats && (
        <span
          className="px-2 text-[11px] tabular-nums text-zinc-400 whitespace-nowrap"
          title={
            "Pictures per second and data received in this browser.\n" +
            "ahead: XenMan asks the host for the next picture itself, without waiting for the browser.\n" +
            "host: how long the host takes to send a picture once asked.\n" +
            "Bars: pictures per second over the last 30 s -- gaps are stalls.\n" +
            "net: round trip between XenMan and this browser (through the NetScaler, if any), typical/longest.\n" +
            "queued: the most that waited at XenMan for this browser lately -- grows when the way to it holds data back."
          }
        >
          <FpsHistory history={stats.history} /> {stats.fps} fps · {stats.kbps} kB/s
          {stats.encoding ? ` · ${stats.encoding}` : ""}
          {proxy &&
            ` · ahead ${proxy.ahead === "on" ? `on (${proxy.aheadPerSec}/s)` : proxy.ahead}` +
              (proxy.hostMs !== null ? ` · host ${proxy.hostMs} ms` : "") +
              (proxy.netMs !== null ? ` · net ${proxy.netMs}/${proxy.netMaxMs} ms` : "") +
              ` · queued ${proxy.queuedKB} KB`}
        </span>
      )}

      <ViewerBadge consoleUrl={consoleUrl} connected={connected} />

      {/* Disconnect */}
      <button
        className="px-3 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-zinc-800 rounded mr-1 transition-colors"
        onClick={() => window.close()}
      >
        Disconnect
      </button>
    </div>
  );
}

/* ── Console Viewer ── */
function ConsoleViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const rfbRef = useRef<RFBInstance | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalDisconnect = useRef(false);
  /** Bytes received from the console, for the connection info. */
  const bytes = useRef(0);
  /** This connection's id for XenMan's measurements (api/console/stats). */
  const statsId = useRef("");

  const consoleUrl = searchParams.get("consoleUrl");
  const sessionId = searchParams.get("sessionId");
  const useSsl = searchParams.get("useSsl") ?? "true";
  const label = searchParams.get("label") ?? "Console";
  const host = searchParams.get("host");
  const port = searchParams.get("port");
  const vmRef = searchParams.get("vmRef");

  const connect = useCallback(async () => {
    if (!consoleUrl || !sessionId || !containerRef.current) return;

    document.title = label;

    // Clean up previous RFB DOM elements (noVNC adds canvases to the container)
    const container = containerRef.current;
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    statsId.current = crypto.randomUUID();
    const proxyParams = new URLSearchParams({ consoleUrl, sessionId, useSsl, statsId: statsId.current });
    const wsUrl = `${wsProtocol}//${window.location.host}/api/vnc-proxy?${proxyParams}`;

    const { default: RFB } = await import("@/lib/novnc/rfb.js");

    if (!containerRef.current) return;

    // Opened here rather than by noVNC, to count what arrives.
    const socket = new WebSocket(wsUrl, ["binary"]);
    socket.addEventListener("message", (e) => {
      const d = e.data as ArrayBuffer | Blob;
      bytes.current += "byteLength" in d ? d.byteLength : d.size;
    });
    const rfb = new RFB(containerRef.current, socket) as unknown as RFBInstance;
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    applyQuality(rfb, savedQuality());
    rfbRef.current = rfb;

    rfb.addEventListener("connect", () => {
      setConnected(true);
      setReconnecting(false);
    });

    rfb.addEventListener("credentialsrequired", () => {
      rfb.sendCredentials({ password: "" });
    });

    rfb.addEventListener("disconnect", () => {
      setConnected(false);
      rfbRef.current = null;

      // Auto-reconnect unless the user closed the window intentionally
      if (!intentionalDisconnect.current) {
        setReconnecting(true);
        reconnectTimer.current = setTimeout(() => {
          connect();
        }, 2000);
      }
    });
  }, [consoleUrl, sessionId, useSsl, label]);

  useEffect(() => {
    connect();
    return () => {
      intentionalDisconnect.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch {
          // already disconnected
        }
      }
    };
  }, [connect]);

  if (!consoleUrl || !sessionId) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100vw",
          height: "100vh",
          color: "#888",
          fontFamily: "monospace",
        }}
      >
        Missing console parameters
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#000",
      }}
    >
      <ConsoleToolbar
        rfb={rfbRef.current}
        label={label}
        connected={connected}
        host={host}
        port={port}
        useSsl={useSsl}
        sessionRef={sessionId}
        vmRef={vmRef}
        consoleUrl={consoleUrl}
        bytes={bytes}
        statsId={statsId}
      />
      <div style={{ flex: 1, overflow: "hidden", background: "#000", position: "relative" }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {reconnecting && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.8)",
              color: "#aaa",
              fontFamily: "monospace",
              fontSize: 14,
              zIndex: 10,
            }}
          >
            Reconnecting...
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Page ── */
export default function ConsolePage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100vw",
            height: "100vh",
            color: "#888",
            fontFamily: "monospace",
            background: "#000",
          }}
        >
          Loading console...
        </div>
      }
    >
      <ConsoleViewer />
    </Suspense>
  );
}
