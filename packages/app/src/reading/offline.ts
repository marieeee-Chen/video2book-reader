export function registerOfflineShell() {
  if ('serviceWorker' in navigator && ['http:', 'https:'].includes(location.protocol)) {
    const base = new URL(import.meta.env.BASE_URL, location.href)
    void navigator.serviceWorker.register(new URL('sw.js', base)).catch(() => undefined)
  }
}
