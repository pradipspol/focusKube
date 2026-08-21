const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopMenu', {
  onAction: (handler) => {
    const listener = (_event, action) => handler(action);
    ipcRenderer.on('desktop-menu-action', listener);
    return () => ipcRenderer.removeListener('desktop-menu-action', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fetchGithubFile: (path) => ipcRenderer.invoke('fetch-github-file', path),
  fetchLatestRelease: () => ipcRenderer.invoke('fetch-latest-release'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  setTheme: (theme) => ipcRenderer.invoke('set-native-theme', theme),
});
