"use strict";

(function exposeUiInteractions(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UiInteractions = api;
})(typeof window === "undefined" ? globalThis : window, () => {
  const FOCUSABLE_SELECTOR = [
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "a[href]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  function focusableElements(container) {
    if (!container) return [];
    return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
      return element.getClientRects().length > 0;
    });
  }

  function nextRovingIndex(current, length, key, columns = 1) {
    if (length <= 0) return -1;
    const index = Math.min(Math.max(current, 0), length - 1);
    const movement = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -Math.max(1, columns),
      ArrowDown: Math.max(1, columns)
    }[key];
    if (key === "Home") return 0;
    if (key === "End") return length - 1;
    if (!movement) return index;
    return Math.min(Math.max(index + movement, 0), length - 1);
  }

  function createModalController({ background, documentRef = document } = {}) {
    let active = null;

    function open(dialog, { initialFocus, returnFocus, onClose } = {}) {
      if (!dialog) return;
      if (active && active.dialog !== dialog) close(active.dialog, { restoreFocus: false });
      active = {
        dialog,
        returnFocus: returnFocus || documentRef.activeElement,
        onClose
      };
      dialog.inert = false;
      dialog.classList.add("open");
      dialog.setAttribute("aria-hidden", "false");
      if (background) background.inert = true;
      requestAnimationFrame(() => {
        const target = initialFocus || focusableElements(dialog)[0];
        target?.focus({ preventScroll: true });
      });
    }

    function close(dialog = active?.dialog, { restoreFocus = true } = {}) {
      if (!dialog || !active || active.dialog !== dialog) return false;
      const state = active;
      const target = state.returnFocus;
      dialog.classList.remove("open");
      dialog.setAttribute("aria-hidden", "true");
      dialog.inert = true;
      if (background) background.inert = false;
      active = null;
      state.onClose?.();
      if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
      return true;
    }

    function handleKeydown(event) {
      if (!active) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(active.dialog);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && documentRef.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && documentRef.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    documentRef.addEventListener("keydown", handleKeydown, true);
    return {
      open,
      close,
      isOpen: (dialog) => Boolean(active && (!dialog || active.dialog === dialog)),
      destroy: () => documentRef.removeEventListener("keydown", handleKeydown, true)
    };
  }

  return { createModalController, focusableElements, nextRovingIndex };
});
