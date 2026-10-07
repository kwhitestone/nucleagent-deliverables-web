import type { IMReference } from "@/addons/deliverables/api/contracts";

/** Same rules as toolgate conversationLink.ts / im-web parseConversationTarget. */
export function validIMReference(value: unknown): value is IMReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as IMReference;
  const uid = (v: unknown): v is string => typeof v === "string" &&
    /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n;
  if (!uid(r.agentUid) || typeof r.channelId !== "string" || !/^[!-~]{1,191}$/.test(r.channelId)) return false;
  if (r.channelType === 2) return true;
  if (r.channelType !== 1) return false;
  const pair = r.channelId.split("@");
  return pair.length === 2 && pair.every(uid) && BigInt(pair[0]) < BigInt(pair[1]) && pair.includes(r.agentUid);
}

/**
 * Conversation ID -> where it was born. IM rows (valid imReference) open the IM
 * channel directly via the shell's `/im?imChannelId&imChannelType&imAgentUid`
 * (web im-remote/conversationTarget.ts); everything else opens `/chat/<id>`
 * (toolgate rule, positive safe integer only). Returns null for the
 * conversation the page is already scoped to (the /chat drawer): no self-link.
 */
export function conversationHref(
  origin: string,
  row: { conversationId: unknown; imReference?: unknown },
  currentConversationId?: number,
): string | null {
  const id = row.conversationId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id === currentConversationId) return null;
  const shell = new URL(origin).origin;
  if (validIMReference(row.imReference)) {
    const url = new URL("/im", shell);
    url.searchParams.set("imChannelId", row.imReference.channelId);
    url.searchParams.set("imChannelType", String(row.imReference.channelType));
    url.searchParams.set("imAgentUid", row.imReference.agentUid);
    return url.toString();
  }
  return `${shell}/chat/${id}`;
}

/** Embedded: navigate the shell itself; standalone: leave this app open. */
export function conversationTarget(win: Pick<Window, "parent"> = window): "_top" | "_blank" {
  return win.parent === win ? "_blank" : "_top";
}

/** Programmatic open for the phone row sheet (buttons, not anchors). */
export function openConversation(href: string, win: Pick<Window, "parent" | "open"> = window): void {
  const target = conversationTarget(win);
  if (target === "_top") win.open(href, "_top");
  else win.open(href, "_blank", "noopener,noreferrer");
}
