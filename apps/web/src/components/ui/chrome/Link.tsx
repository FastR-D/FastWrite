import type { AnchorHTMLAttributes, ReactNode } from "react";
import styles from "./Link.module.css";

export type LinkTarget =
  | { kind: "internal"; href: string }
  | { kind: "anchor"; href: string }
  | { kind: "external"; href: string };

/**
 * Classifies a link target so the component knows whether to intercept the
 * click. Internal paths must not trigger a full page load — this app has a
 * service worker and an offline workspace layer, and a hard navigation throws
 * away in-flight editor state.
 */
export function linkTarget(href: string): LinkTarget {
  if (href.startsWith("#")) return { kind: "anchor", href };
  if (href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "external", href };
  return { kind: "internal", href };
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children: ReactNode;
  /**
   * `text`: accent colour with an underline on hover.
   * `button`: the global button classes (the export/download pattern).
   * `inherit`: no colour of its own, for links whose container already sets
   *   one — a brand wordmark, a nav bar, a footer. Needed because this module's
   *   stylesheet is loaded after `styles.css`, so at equal specificity a
   *   consumer class cannot override the `text` variant's colour.
   */
  variant?: "text" | "button" | "inherit";
  /**
   * Download the target as a file. Accepts a bare `download` (boolean) as well
   * as a filename, matching the HTML attribute.
   */
  download?: string | boolean;
}

export function Link({ href, children, variant = "text", className = "", onClick, download, ...rest }: LinkProps) {
  const target = linkTarget(href);
  /*
   * The button variant reuses the global button classes so it matches the
   * export/download anchors elsewhere in the app. The text variant needs its
   * own base class: there is no global `a` rule, so an unstyled anchor would
   * render with browser-default blue and an underline.
   */
  const classes = [
    variant === "button" ? "button button--secondary" : variant === "inherit" ? styles.inherit : styles.link,
    className
  ].filter(Boolean).join(" ");

  return (
    <a
      {...rest}
      href={href}
      className={classes}
      {...(download !== undefined ? { download } : {})}
      {...(target.kind === "external" && download === undefined ? { rel: "noreferrer noopener", target: "_blank" } : {})}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        /*
         * A `download` link must never be intercepted. Our export endpoints are
         * same-origin (`/api/projects/:id/export`), so they classify as
         * internal — and the pushState below would cancel the navigation before
         * the browser could start the download, leaving the click doing nothing.
         * The attribute means "fetch this as a file", never "go there".
         */
        if (download !== undefined) return;
        // Anchors and external links keep native behaviour: the browser handles
        // the hash jump, and a new tab is what the user asked for.
        if (target.kind !== "internal" || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        window.history.pushState(null, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      {children}
    </a>
  );
}
