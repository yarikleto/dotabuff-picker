import { useEffect, type RefObject } from "react";

/**
 * Opening a sheet moves focus into it, because it pushes the board far down the
 * page. Escape closes it only from inside: in the search box Escape clears the
 * search, and over a pinned hero card it closes the card.
 */
export function useSheetFocus(panel: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const sheet = panel.current;
    if (!sheet) return;
    // A plain focus() scrolls a sheet taller than the window up to the top edge,
    // under the sticky bar, hiding its own header. Scroll only when the sheet
    // starts above the bar's bottom edge, and only far enough to clear it.
    sheet.focus({ preventScroll: true });
    const clear = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const top = sheet.getBoundingClientRect().top;
    if (top < clear) window.scrollBy({ top: top - clear - 8 });
  }, [panel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && panel.current?.contains(document.activeElement)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, onClose]);
}
