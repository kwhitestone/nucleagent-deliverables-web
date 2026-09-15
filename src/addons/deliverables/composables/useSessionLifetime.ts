import { onBeforeUnmount } from "vue";
import {
  assertCurrentSessionRequest,
  captureSessionRequest,
  SESSION_CHANGE_EVENT,
  type SessionRequest,
} from "./embeddedSession";

export interface SessionOperation {
  readonly session: SessionRequest;
  readonly signal: AbortSignal;
}

export function isCancelled(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

export function useSessionLifetime(onSessionChange: () => void) {
  let local = new AbortController();
  let disposed = false;

  function invalidate(): void {
    const previous = local;
    local = new AbortController();
    previous.abort();
  }

  function capture(): SessionOperation {
    const session = captureSessionRequest();
    return { session, signal: AbortSignal.any([session.signal, local.signal]) };
  }

  function isCurrent(owner: SessionOperation): boolean {
    if (disposed || owner.signal.aborted) return false;
    try {
      assertCurrentSessionRequest(owner.session);
      return true;
    } catch {
      return false;
    }
  }

  function assertCurrent(owner: SessionOperation): void {
    if (!isCurrent(owner)) throw new DOMException("Operation ended", "AbortError");
  }

  function retireSession(): void {
    invalidate();
    onSessionChange();
  }

  window.addEventListener(SESSION_CHANGE_EVENT, retireSession);
  onBeforeUnmount(() => {
    disposed = true;
    local.abort();
    window.removeEventListener(SESSION_CHANGE_EVENT, retireSession);
  });

  return { capture, invalidate, isCurrent, assertCurrent };
}
