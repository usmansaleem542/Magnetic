const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args)
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const on = channel => fn => {
  const listener = (_e, payload) => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  call,
  pathForFile: file => webUtils.getPathForFile(file),
  onTorrents: on('torrents'),
  onEmbeddedSubs: on('embedded-subs'),
  onToast: on('toast'),
  onMenu: on('menu')
})
