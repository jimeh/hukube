import type { EngineEndpoint } from "@hukube/engine-client";

export type { EngineEndpoint };

/**
 * The environment the UI runs in. UI code reaches platform features only
 * through this interface, so it runs unchanged on the desktop and in a
 * browser (ADR-0007).
 */
export interface Host {
  readonly kind: "desktop" | "web";
  /** Where the Engine listens, and the token it requires. */
  engine(): Promise<EngineEndpoint>;
  /** Opens an app path, such as a Cluster's Workspace, in a new window. */
  openWindow(path: string): void;
  openExternal(url: string): void;
}

/** The API the desktop Host's preload script exposes as `window.hukubeDesktop`. */
export interface DesktopBridge {
  engine(): Promise<EngineEndpoint>;
  openWindow(path: string): void;
  openExternal(url: string): void;
}

declare global {
  interface Window {
    hukubeDesktop?: DesktopBridge;
  }
}

export function createDesktopHost(bridge: DesktopBridge): Host {
  return {
    kind: "desktop",
    engine: () => bridge.engine(),
    openWindow: (path) => bridge.openWindow(path),
    openExternal: (url) => bridge.openExternal(url),
  };
}

const tokenKey = "hukube.engineToken";

/**
 * A Host for browsers. The Engine is reached on the page's own origin, served
 * by the Engine itself or proxied by the dev server. Its token arrives in the
 * URL fragment (`#token=...`), which is moved to session storage and removed
 * from the address bar.
 */
export function createBrowserHost(): Host {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fromUrl = fragment.get("token");
  if (fromUrl) {
    sessionStorage.setItem(tokenKey, fromUrl);
    fragment.delete("token");
    const rest = fragment.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search + (rest ? `#${rest}` : ""),
    );
  }
  const token = sessionStorage.getItem(tokenKey);
  const url = window.location.origin;

  return {
    kind: "web",
    engine: () =>
      token
        ? Promise.resolve({ url, token })
        : Promise.reject(
            new Error("No Engine token. Open the URL printed by hukube-engine, which includes it."),
          ),
    openWindow: (path) => {
      window.open(
        token ? `${path}#token=${encodeURIComponent(token)}` : path,
        "_blank",
        "noopener",
      );
    },
    openExternal: (externalUrl) => {
      window.open(externalUrl, "_blank", "noopener,noreferrer");
    },
  };
}

/** Returns the desktop Host when running inside the desktop app, else the browser Host. */
export function detectHost(): Host {
  return window.hukubeDesktop ? createDesktopHost(window.hukubeDesktop) : createBrowserHost();
}
