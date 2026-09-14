export interface DeliverablesPageContext {
  conversationId?: number;
  embedded: boolean;
}

export function resolvePageContext(search: string): DeliverablesPageContext {
  const params = new URLSearchParams(search);
  const parsed = Number(params.get("conversationId") ?? "");
  const conversationId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  return { conversationId, embedded: params.get("embedded") === "1" };
}
