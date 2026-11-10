import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fastrd/ui-react/styles.css";
import "@fastrd/ui-foundation/vscrui.css";
import "./lib/theme";
import "./styles/tokens.css";
import "./styles.css";
import "vscrui/dist/_name_.css";

document.documentElement.classList.add("fastui-vscrui");

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").then((registration) => {
      if (navigator.onLine) void registration.update().catch(() => undefined);
    }).catch(() => undefined);
  });
}

window.addEventListener("online", () => window.dispatchEvent(new CustomEvent("fastwrite-network", { detail: "online" })));
window.addEventListener("offline", () => window.dispatchEvent(new CustomEvent("fastwrite-network", { detail: "offline" })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
