'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');

async function run(window,service,output) {
  await fs.mkdir(output,{recursive:true});
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const until=async predicate=>{for(let n=0;n<80;n++){if(await evaluate(predicate))return;await new Promise(r=>setTimeout(r,50));}throw new Error('UI did not reach expected state: '+predicate);};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture=async name=>{await evaluate('document.fonts.ready');await new Promise(r=>setTimeout(r,400));const image=await window.webContents.capturePage({stayHidden:true});await fs.writeFile(path.join(output,name),image.toPNG());};
  await until('!!document.querySelector(\'[data-action="navigate"][data-page="send"]\')');
  assert.ok((await evaluate('document.body.innerText')).includes(service.settings.alias));
  await capture('receive.png');
  await click('[data-action="navigate"][data-page="send"]');
  await click('[data-action="text"]');
  await until('!!document.querySelector("#message-text")');
  await evaluate('document.querySelector("#message-text").value="A local message — UI smoke test";document.querySelector("#text-form").requestSubmit()');
  await until('!!document.querySelector(".selected-files .file-row")');
  assert.equal(service.selection.length,1);
  assert.equal(service.selection[0].text,'A local message — UI smoke test');
  await capture('send.png');
  await click('[data-action="navigate"][data-page="settings"]');
  await until('!!document.querySelector("#settings-alias")');
  await evaluate('document.querySelector("#settings-alias").value="Smoke Maple"');
  await click('[data-action="save-alias"]');
  for(let n=0;n<50&&service.settings.alias!=='Smoke Maple';n++)await new Promise(r=>setTimeout(r,20));
  assert.equal(service.settings.alias,'Smoke Maple');
  await capture('settings.png');
  const {LocalSendService}=require('../src/service');
  const peer=new LocalSendService({dataDir:path.join(output,'peer-data'),downloadDir:path.join(output,'peer-received'),alias:'Loopback test device',port:0,host:'127.0.0.1',discovery:false,autoAccept:true});
  await peer.start();
  try {
    await click('[data-action="navigate"][data-page="send"]');
    await click('[data-action="manual"]');
    await until('!!document.querySelector("#manual-host")');
    await evaluate(`document.querySelector('#manual-host').value='127.0.0.1';document.querySelector('#manual-port').value='${peer.port}';document.querySelector('#manual-protocol').value='https';document.querySelector('#manual-form').requestSubmit()`);
    await until('!!document.querySelector(\'[data-action="send"]\')');
    await click('[data-action="send"]');
    for(let n=0;n<100&&!service.history.some(t=>t.direction==='send'&&t.status==='completed');n++)await new Promise(r=>setTimeout(r,40));
    assert.ok(service.history.some(t=>t.direction==='send'&&t.status==='completed'));
    assert.equal(await fs.readFile(path.join(output,'peer-received','Message.txt'),'utf8'),'A local message — UI smoke test');
    await peer.registerPeer({...service.info(),host:'127.0.0.1'});
    peer.addText('Received through the actual approval dialog.');
    await peer.send(service.info().fingerprint);
    await until('!!document.querySelector(\'[data-action="respond"][data-accept="true"]\')');
    await capture('incoming.png');
    await click('[data-action="respond"][data-accept="true"]');
    for(let n=0;n<100&&!service.history.some(t=>t.direction==='receive'&&t.status==='completed');n++)await new Promise(r=>setTimeout(r,40));
    assert.ok(service.history.some(t=>t.direction==='receive'&&t.status==='completed'));
  } finally {await peer.stop();}
  await click('[data-action="navigate"][data-page="history"]');
  await until('!!document.querySelector("#history-search")');
  await capture('history.png');
  const errors=await evaluate('Array.from(document.querySelectorAll(".startup-error")).map(e=>e.innerText)');
  assert.deepEqual(errors,[]);
  await click('[data-action="navigate"][data-page="settings"]');
  await click('[data-action="theme"][data-id="dark"]');
  await until('document.documentElement.dataset.theme === "dark"');
  await capture('dark.png');
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks:['renderer bridge startup','receive device identity','send navigation','add text via form and IPC','settings alias persisted','manual HTTPS device registration','send via peer card and verify saved message','receive through actual approval modal','history navigation','dark theme'],screenshots:['receive.png','send.png','settings.png','incoming.png','history.png','dark.png']},null,2));
  console.log('UI smoke passed: receive, send, text, settings, manual peer, real transfers, approval, history, dark theme.');
}

module.exports={run};
