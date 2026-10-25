/** Keeps the Engine alive until every window has consented, including updater quits. */
export class Quit {
  restarting = false;
  private installing = false;

  constructor(
    private readonly quit: () => void,
    private readonly install: () => void,
  ) {}

  restart() {
    if (this.restarting) return;
    this.restarting = true;
    this.quit();
  }

  cancelled() {
    this.restarting = false;
  }

  /** will-quit runs after Electron has closed every window with beforeunload. */
  willQuit(): boolean {
    if (!this.restarting || this.installing) return true;
    this.installing = true;
    this.install();
    return false;
  }

  failed() {
    this.restarting = false;
    this.installing = false;
  }
}
