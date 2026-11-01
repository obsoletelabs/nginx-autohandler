"use strict";

// Behaviour every dialog shares: a click on the backdrop closes it, focus lands on the first field
// (not the close button) and goes back to whatever opened it. Escape is native to showModal().

const openers = new WeakMap();

function firstField(dialog) {
  const body = dialog.querySelector(".dialog-body") || dialog;
  return body.querySelector("input:not([hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])");
}

const nativeShowModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function showModal(...args) {
  openers.set(this, document.activeElement);
  nativeShowModal.apply(this, args);
  if (this.classList.contains("quick")) return;
  requestAnimationFrame(() => {
    const active = document.activeElement;
    const onClose = active && active.matches && active.matches("[data-close], [data-cancel]");
    if (this.contains(active) && !onClose) return; // the opener already chose where focus goes
    const target = firstField(this) || this.querySelector(".dialog-actions .primary");
    if (target) target.focus({ preventScroll: true });
  });
};

for (const dialog of document.querySelectorAll("dialog")) {
  let pressedOnBackdrop = false;
  dialog.addEventListener("mousedown", (event) => {
    pressedOnBackdrop = event.target === dialog;
  });
  dialog.addEventListener("click", (event) => {
    if (pressedOnBackdrop && event.target === dialog) dialog.close();
    pressedOnBackdrop = false;
  });
  dialog.addEventListener("close", () => {
    const opener = openers.get(dialog);
    if (opener && document.contains(opener) && typeof opener.focus === "function") opener.focus({ preventScroll: true });
  });
}
