/**
 * Formats the time elapsed since `since` the way kubectl prints ages
 * (k8s.io/apimachinery/pkg/util/duration.HumanDuration), so the UI and
 * kubectl agree.
 */
export function formatAge(since: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - since.getTime()) / 1000);
  if (seconds < 0) return "0s";
  if (seconds < 60 * 2) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) {
    const s = seconds % 60;
    return s === 0 ? `${minutes}m` : `${minutes}m${s}s`;
  }
  if (minutes < 60 * 3) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 8) {
    const m = minutes % 60;
    return m === 0 ? `${hours}h` : `${hours}h${m}m`;
  }
  if (hours < 48) return `${hours}h`;
  if (hours < 24 * 8) {
    const h = hours % 24;
    return h === 0 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours / 24)}d${h}h`;
  }
  if (hours < 24 * 365 * 2) return `${Math.floor(hours / 24)}d`;
  const years = Math.floor(hours / 24 / 365);
  if (years < 8) {
    const d = Math.floor(hours / 24) % 365;
    return d === 0 ? `${years}y` : `${years}y${d}d`;
  }
  return `${years}y`;
}
