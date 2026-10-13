/** Clipboard API is absent on the plain-HTTP web Host. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Fall back when permission is refused. */
    }
  }
  const focused = document.activeElement as HTMLElement | null;
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  // Keep the fallback inside a modal's focus trap when one is open.
  (document.querySelector('[role="dialog"], [role="alertdialog"]') ?? document.body).append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  focused?.focus();
  if (!copied) throw new Error("The Host could not copy the YAML.");
}
