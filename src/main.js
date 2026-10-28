'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { LocalSendService } = require('./service');

app.setName('Super Send');
const root = path.join(__dirname, '..');
const installed=app.isPackaged&&fs.existsSync(path.join(path.dirname(app.getPath('exe')),'installed.flag'));
const dataRoot = process.env.LOCALSEND_DATA_DIR || (installed ? path.join(app.getPath('appData'),'LocalSend Rebuilt') : app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'data') : path.join(root, '.local'));
app.setPath('userData', dataRoot);
app.setAppUserModelId('org.localsend.rebuilt');
const hasLock = app.requestSingleInstanceLock();
if (!hasLock && !process.env.LOCALSEND_ALLOW_MULTIPLE) app.quit();

let window;
let service;
let quitting = false;

function authorize(event) { if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unknown application window'); }
function register(name, handler) { ipcMain.handle(`localsend:${name}`, async(event,...args)=>{ authorize(event); return handler(...args); }); }
function allowedPath(value) { return [...service.transfers,...service.history].some(t=>t.files?.some(f=>f.path===value)); }

async function createWindow() {
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ title:'Super Send', width:1160, height:790, minWidth:820, minHeight:610, backgroundColor:'#0b1020', icon:path.join(root,'renderer','assets','logo.png'), show:false, autoHideMenuBar:true, webPreferences:{ preload:path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false, sandbox:true, offscreen:!!process.env.LOCALSEND_UI_SMOKE, backgroundThrottling:!process.env.LOCALSEND_UI_SMOKE } });
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.on('page-title-updated',event=>{event.preventDefault();window.setTitle('Super Send');});
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('file://'))event.preventDefault();});
  window.once('ready-to-show',()=>{if(!process.env.LOCALSEND_UI_SMOKE&&!process.env.LOCALSEND_SCREENSHOT)window.show();});
  window.on('closed',()=>{window=null;});
  const firstRun=!fs.existsSync(path.join(dataRoot,'settings.json'));
  service = new LocalSendService({dataDir:dataRoot,...(process.env.LOCALSEND_DOWNLOAD_DIR||firstRun?{downloadDir:process.env.LOCALSEND_DOWNLOAD_DIR || (installed?path.join(app.getPath('downloads'),'Super Send'):path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : root,'received'))} : {}),...(process.env.LOCALSEND_PORT ? {port:Number(process.env.LOCALSEND_PORT)} : {}),...(process.env.LOCALSEND_UI_SMOKE?{discovery:false}:{})});
  const setupAudit=!!process.env.LOCALSEND_UI_SMOKE&&process.env.LOCALSEND_NETWORK_TEST==='1';
  service.on('state',state=>{ if(window&&!window.isDestroyed()){nativeTheme.themeSource=state.settings.theme||'system';window.webContents.send('localsend:state',state);const active=state.transfers.find(t=>t.status==='transferring');window.setProgressBar(active?active.progress:-1);const dark=state.settings.theme==='dark'||(state.settings.theme==='system'&&nativeTheme.shouldUseDarkColors);window.setBackgroundColor(dark?'#0b1020':'#f3f6fd');} });
  register('getState',()=>service.getState());
  register('selectFiles',async()=>{const result=await dialog.showOpenDialog(window,{title:'Select files to send',properties:['openFile','multiSelections']});return result.canceled?service.getState():service.addPaths(result.filePaths);});
  register('selectFolder',async()=>{const result=await dialog.showOpenDialog(window,{title:'Select a folder to send',properties:['openDirectory']});return result.canceled?service.getState():service.addPaths(result.filePaths);});
  register('chooseDownloadDirectory',async()=>{const result=await dialog.showOpenDialog(window,{title:'Receive files in',defaultPath:service.settings.downloadDir,properties:['openDirectory','createDirectory']});return result.canceled?service.getState():service.updateSettings({downloadDir:result.filePaths[0]});});
  for(const name of ['addPaths','addText','removeSelection','clearSelection','discover','addPeer','send','respond','updateSettings','cancelTransfer'])register(name,(...args)=>service[name](...args));
  register('openDownloads',async()=>{fs.mkdirSync(service.settings.downloadDir,{recursive:true});const error=await shell.openPath(service.settings.downloadDir);if(error)throw new Error(error);});
  register('openFile',file=>{if(!allowedPath(file))throw new Error('The file is not in your transfer history.');shell.showItemInFolder(file);});
  register('copyText',text=>clipboard.writeText(String(text)));
  register('readClipboard',()=>clipboard.readText());
  try { await service.start(); } catch(error) {service.network.error=`Could not start the receiver: ${error.message}`;service.changed(true);}
  await window.loadFile(path.join(root,'renderer','index.html'));
  if(process.env.LOCALSEND_UI_SMOKE){try{await require(setupAudit?'../scripts/ui-network-setup':process.env.LOCALSEND_UI_AUDIT?'../scripts/ui-audit':'../scripts/ui-smoke').run(window,service,process.env.LOCALSEND_UI_SMOKE);app.quit();}catch(error){console.error(error);app.exit(1);}return;}
  if(process.env.LOCALSEND_SCREENSHOT){setTimeout(async()=>{try{const image=await window.webContents.capturePage();fs.writeFileSync(process.env.LOCALSEND_SCREENSHOT,image.toPNG());console.log('Screenshot saved');if(process.env.LOCALSEND_SMOKE_EXIT)app.quit();}catch(error){console.error(error);app.exit(1);}},1800);}
}

app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
app.whenReady().then(createWindow).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(!quitting&&service){event.preventDefault();quitting=true;service.stop().finally(()=>app.quit());}});
