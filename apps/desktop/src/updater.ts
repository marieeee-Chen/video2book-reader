import { invoke } from '@tauri-apps/api/core'
export async function desktopUpdate() {
  if (!await invoke<boolean>('updates_enabled')) return '此本地构建尚未启用发行更新。'
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check({ timeout: 20_000 })
  if (!update) return '已经是最新版本。'
  if (!window.confirm(`发现 ${update.version}。安装并关闭当前阅读器？`)) return '更新已取消。'
  await update.downloadAndInstall()
  return '更新已安装，请重新打开阅读器。'
}
