export function createBackupNotifier() {
  let audio: AudioContext | null = null;
  let notification: Notification | null = null;
  let disposed = false;

  async function prepareSound() {
    if (disposed || typeof window === "undefined" || !window.AudioContext) return;
    try {
      audio ||= new window.AudioContext();
      if (audio.state === "suspended") await audio.resume();
    } catch { /* Browser audio restrictions do not affect backup. */ }
  }

  async function enableDesktop() {
    if (typeof Notification === "undefined") return "unsupported";
    try { return Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission; }
    catch { return "unsupported"; }
  }

  function notify(title: string, message: string, failed: boolean) {
    if (disposed) return;
    if (audio?.state === "running") {
      try {
        for (const [index, frequency] of (failed ? [440, 330] : [660, 880, 1046]).entries()) {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const start = audio.currentTime + index * 0.22;
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
          oscillator.connect(gain); gain.connect(audio.destination);
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
          oscillator.start(start); oscillator.stop(start + 0.2);
        }
      } catch { /* A muted or suspended audio context cannot interrupt backup. */ }
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState === "hidden") {
      try {
        notification?.close();
        notification = new Notification(title, { body: message, tag: "framebase-full-backup" });
        notification.onclick = () => { window.focus(); notification?.close(); };
      } catch { /* Desktop notifications are unavailable in some browsers. */ }
    }
  }

  function dispose() {
    disposed = true;
    notification?.close();
    void audio?.close().catch(() => undefined);
  }

  return { prepareSound, enableDesktop, notify, dispose };
}
