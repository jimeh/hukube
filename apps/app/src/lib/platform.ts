/** Whether the Host's shortcuts use Cmd, as on macOS, instead of Ctrl. */
export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Explicit source for every command matcher, formatter and recorder call. */
export const commandPlatform = isMac
  ? "mac"
  : /Windows/.test(navigator.userAgent)
    ? "windows"
    : "linux";
