'use strict';
// Sandbox-safe preload: exposes a narrow, promise-based update API to the web UI. No Node or
// Electron objects are leaked to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jptiDesktop', Object.freeze({
  isDesktop: true,
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke('jpti:update:get-state'),
    check: () => ipcRenderer.invoke('jpti:update:check'),
    download: () => ipcRenderer.invoke('jpti:update:download'),
    cancel: () => ipcRenderer.invoke('jpti:update:cancel'),
    install: () => ipcRenderer.invoke('jpti:update:install'),
    openRelease: () => ipcRenderer.invoke('jpti:update:open-release'),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const handler = (_event, nextState) => callback(nextState);
      ipcRenderer.on('jpti:update:state', handler);
      return () => ipcRenderer.removeListener('jpti:update:state', handler);
    }
  })
}));
