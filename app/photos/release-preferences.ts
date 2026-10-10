function preferenceKey(username: string) {
  return `framebase-user:${username}:photo-auto-release-after-review`;
}

export function readAutoReleasePreference(username: string): boolean {
  try { return localStorage.getItem(preferenceKey(username)) === "1"; }
  catch { return false; }
}

export function saveAutoReleasePreference(username: string, enabled: boolean) {
  localStorage.setItem(preferenceKey(username), enabled ? "1" : "0");
}
