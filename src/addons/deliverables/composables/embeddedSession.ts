import { clearAccessToken, getAccessToken, setAccessToken } from "@/addons/deliverables/utils/token";
import { createRemoteChildChannel } from "@prism-fusion/plugin-runtime/remote";
import { setLocale, translate } from "@/i18n";
import { deliverablesShellPath, redirectToShellLogin } from "../shellLogin";
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
let requestScope = new AbortController();

export interface SessionRequest {
  readonly token: string;
  readonly signal: AbortSignal;
}

export function captureSessionRequest(): SessionRequest {
  return { token: getAccessToken(), signal: requestScope.signal };
}

function isCurrentSessionRequest(request: SessionRequest): boolean {
  return request.signal === requestScope.signal && !request.signal.aborted && request.token === getAccessToken();
}

export function assertCurrentSessionRequest(request: SessionRequest): void {
  if (!isCurrentSessionRequest(request)) throw new DOMException("Session changed", "AbortError");
}

function retireRequests(): void {
  const previous = requestScope;
  requestScope = new AbortController();
  previous.abort();
}

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
  if (changed) {
    retireRequests();
    emitSessionChange(Boolean(token));
  }
  return { accepted: true, changed };
}

export function handleEmbeddedUnauthorized(reason: "missing" | "rejected", request: SessionRequest): void {
  if (!isCurrentSessionRequest(request)) return;
  const version = currentVersion;
  if (reason === "rejected") {
    clearAccessToken();
    rejectedVersion = version;
    retireRequests();
    emitSessionChange(false);
  }
  if (version !== currentVersion || (reason === "rejected" && getAccessToken())) return;
  if (window.parent === window) {
    leaveForShellLogin();
    return;
  }
  const key = `${version}:${reason}`;
  if (lastNotification === key) return;
  const sent = activeChannel?.send("auth-required", {
    source: "sub",
    type: "auth-required",
    reason,
    sessionVersion: version,
  });
  if (sent) lastNotification = key;
}

/** Standalone only: interstitial, then the shell's /login (login-ux-board §04). */
export function leaveForShellLogin(): void {
  redirectToShellLogin(SHELL_ORIGIN, deliverablesShellPath(window.location.pathname + window.location.search), {
    title: translate("redirectingTitle"),
    body: translate("redirectingBody"),
  });
}

export function installShellBridge(): () => void {
  if (window.parent === window) return () => undefined;
  const channel = createRemoteChildChannel({
    appId: "deliverables",
    hostOrigin: SHELL_ORIGIN,
    allowedHostOrigins: import.meta.env?.VITE_SHELL_ALLOWED_ORIGINS,
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
