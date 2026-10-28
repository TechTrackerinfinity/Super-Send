'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const api = {};
for (const method of ['getState','selectFiles','selectFolder','chooseDownloadDirectory','addPaths','addText','removeSelection','clearSelection','discover','addPeer','send','respond','updateSettings','openDownloads','openFile','copyText','readClipboard','cancelTransfer']) {
  api[method] = (...args) => ipcRenderer.invoke(`localsend:${method}`,...args);
}
api.getDroppedPaths = files => Array.from(files).map(file=>webUtils.getPathForFile(file)).filter(Boolean);
api.onState = listener => { const callback=(_event,state)=>listener(state);ipcRenderer.on('localsend:state',callback);return()=>ipcRenderer.removeListener('localsend:state',callback); };
contextBridge.exposeInMainWorld('localSend',Object.freeze(api));
