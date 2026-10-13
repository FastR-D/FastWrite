// This tiny independent script can offer recovery even if the app bundle fails.
(() => {
  const retry = document.getElementById("fastwrite-boot-retry");
  retry?.addEventListener("click", () => window.location.reload());
  const showRecovery = (failed) => {
    if (!document.getElementById("fastwrite-boot")) return;
    const message = document.getElementById("fastwrite-boot-message");
    if (message) message.textContent = failed ? "FastWrite could not load. Check your connection and reload." : "Loading is taking longer than usual. You can reload to try again.";
    if (retry) retry.hidden = false;
  };
  window.addEventListener("error", (event) => {
    if (event.target instanceof HTMLScriptElement) showRecovery(true);
  }, true);
  window.setTimeout(() => showRecovery(false), 15_000);
})();
