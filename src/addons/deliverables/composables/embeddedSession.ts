import { clearAccessToken, getAccessToken, setAccessToken } from "@/addons/deliverables/utils/token";
import { createRemoteChildChannel } from "@prism-fusion/plugin-runtime/remote";
import { setLocale } from "@/i18n";
import { resolveShellLocale, shouldAcceptShellSession } from "./embeddedSessionPolicy";

const REFRESH_TOKEN_KEY = "nucleagent_refresh_token";
const SESSION_VERSION_KEY = "nucleagent_session_version";
export const SESSION_CHANGE_EVENT = "nucleagent:session-change";

const runtimeConfig = (globalThis as typeof globalThis & {
  __NUCLEAGENT_DELIVERABLES_CONFIG__?: { shellUrl?: string };
}).__NUCLEAGENT_DELIVERABLES_CONFIG__;

const SHELL_ORIGIN = new URL(
  runtimeConfig?.shellUrl?.trim() || import.meta.env.VITE_SHELL_URL || "http://localhost:26600",
  window.location.origin,
).origin;

let rejectedVersion: number | null = null;
let currentVersion = 0;
let lastNotification = "";
let activeChannel: ReturnType<typeof createRemoteChildChannel> | undefined;

function emitSessionChange(authenticated: boolean): void {
  window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { authenticated } }));
}

export function applyShellSession(token: string | null, incomingVersion: number) {
  if (!shouldAcceptShellSession(currentVersion, rejectedVersion, incomingVersion, Boolean(token))) {
    return { accepted: false, changed: false };
  }
  const previousToken = getAccessToken();
  const changed = previousToken !== (token ?? "") || currentVersion !== incomingVersion;
  currentVersion = incomingVersion;
  localStorage.setItem(SESSION_VERSION_KEY, String(incomingVersion));
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  if (token) setAccessToken(token);
  else clearAccessToken();
  if (incomingVersion > (rejectedVersion ?? -1) || !token) rejectedVersion = null;
  lastNotification = "";
  if (changed) emitSessionChange(Boolean(token));
  return { accepted: true, changed };
}

export function handleEmbeddedUnauthorized(reason: "missing" | "rejected"): void {
  if (reason === "rejected") {
    clearAccessToken();
    rejectedVersion = currentVersion;
    emitSessionChange(false);
  }
  if (window.parent === window) return;
  const key = `${currentVersion}:${reason}`;
  if (lastNotification === key) return;
  lastNotification = key;
  activeChannel?.send("auth-required", {
    source: "sub",
    type: "auth-required",
    reason,
    sessionVersion: currentVersion,
  });
}

export function installShellBridge(): () => void {
  if (window.parent === window) return () => undefined;
  const channel = createRemoteChildChannel({
    appId: "deliverables",
    hostOrigin: SHELL_ORIGIN,
    parent: window.parent,
    messages: {
      toChild: ["auth", "locale"],
      fromChild: ["auth-required"],
    },
    onMessage(type, payload) {
      if (type === "locale") {
        const shellLocale = resolveShellLocale(payload);
        if (shellLocale) setLocale(shellLocale);
        return;
      }
      if (type !== "auth" || !payload || typeof payload !== "object") return;
      const data = payload as {
        source?: string;
        type?: string;
        token?: string | null;
        sessionVersion?: number;
      };
      if (data.source !== "shell" || data.type !== "auth") return;
      if (!Number.isSafeInteger(data.sessionVersion)) return;
      applyShellSession(data.token ?? null, data.sessionVersion as number);
    },
  });
  activeChannel = channel;
  const onMessage = (event: MessageEvent) => channel.receive(event);
  window.addEventListener("message", onMessage);
  channel.ready();
  return () => {
    window.removeEventListener("message", onMessage);
    channel.dispose();
    if (activeChannel === channel) activeChannel = undefined;
  };
}
