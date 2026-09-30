export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

type ShareNavigator = {
  share?: (data: { title?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
};

/** Board §15 ④: `navigator.share`, falling back to copying the link. */
export async function shareOrCopy(nav: ShareNavigator | undefined, data: { title: string; url: string }): Promise<ShareOutcome> {
  if (typeof nav?.share === "function") {
    try {
      await nav.share(data);
      return "shared";
    } catch (reason) {
      if ((reason as { name?: string } | null)?.name === "AbortError") return "cancelled";
    }
  }
  try {
    if (!nav?.clipboard) return "failed";
    await nav.clipboard.writeText(data.url);
    return "copied";
  } catch {
    return "failed";
  }
}
