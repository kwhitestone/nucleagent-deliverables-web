/**
 * Conversation ID -> shell Agent conversation page, same `/chat/<id>` rule as
 * toolgate frontend/src/pages/conversationLink.ts. IM-born conversations are
 * Core conversations too, so they open here as well (phase 2 adds an IM link).
 * Returns null for the conversation the page is already scoped to (the /chat
 * drawer): linking a conversation to itself would only reload the shell.
 */
export function conversationHref(origin: string, id: unknown, currentConversationId?: number): string | null {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id === currentConversationId) return null;
  return `${new URL(origin).origin}/chat/${id}`;
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
