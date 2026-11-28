'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');

test('Windows lifecycle starts once, restarts only its bridge, and installs/removes a shortcut in a TEST startup directory',async t=>{
  if(process.platform!=='win32'){t.skip('Windows lifecycle test');return;}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bogam-lifecycle-'));
  const app=path.join(dir,'app','bogam-bridge'),privateDir=path.join(dir,'private'),startup=path.join(dir,'test-startup');
  for(const folder of [app,privateDir,startup])fs.mkdirSync(folder,{recursive:true});
  const manager=path.join(app,'manage-bridge.ps1');
  fs.copyFileSync(path.join(__dirname,'../bogam-bridge/manage-bridge.ps1'),manager);
  // A TCP-only fake, never importing a SQL module or opening a DB connection.
  fs.writeFileSync(path.join(app,'bridge.js'),`const fs=require('fs'),net=require('net');const c=JSON.parse(fs.readFileSync(process.env.BOGAM_BRIDGE_CONFIG,'utf8').replace(/^\\uFEFF/,''));net.createServer(s=>s.end()).listen(c.port,c.listenHost,()=>console.log('FAKE_BRIDGE_NO_SQL'));`);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const configPath=path.join(privateDir,'bridge.json');fs.writeFileSync(configPath,JSON.stringify({listenHost:'127.0.0.1',port,applyEnabled:false}));
  const pidFile=path.join(privateDir,'runtime','bridge-process.json');
  const run=action=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',manager,
    '-Action',action,'-ConfigPath',configPath,'-StartupDirectory',startup],{encoding:'utf8',windowsHide:true,timeout:25000});
  let unrelated;
  t.after(()=>{run('Stop');if(unrelated)unrelated.kill();});
  const enabled=run('EnableStartup');assert.equal(enabled.status,0,enabled.stdout+enabled.stderr);
  assert.ok(fs.existsSync(path.join(startup,'InhouseBogamBridge.lnk')));
  // Registering startup must not start a process or query anything.
  assert.equal(fs.existsSync(pidFile),false);
  const started=run('Start');assert.equal(started.status,0,started.stdout+started.stderr);assert.match(started.stdout,/BRIDGE_READY_NO_DATABASE_QUERY_EXECUTED/);
  const first=JSON.parse(fs.readFileSync(pidFile,'utf8'));
  const duplicate=run('Start');assert.equal(duplicate.status,0,duplicate.stdout+duplicate.stderr);assert.match(duplicate.stdout,/ALREADY_RUNNING/);
  assert.equal(JSON.parse(fs.readFileSync(pidFile,'utf8')).processId,first.processId);
  const restarted=run('Restart');assert.equal(restarted.status,0,restarted.stdout+restarted.stderr);
  const second=JSON.parse(fs.readFileSync(pidFile,'utf8'));assert.notEqual(second.processId,first.processId);
  assert.match(run('Status').stdout,/BRIDGE_RUNNING/);
  const disabled=run('DisableStartup');assert.equal(disabled.status,0,disabled.stdout+disabled.stderr);
  assert.equal(fs.existsSync(path.join(startup,'InhouseBogamBridge.lnk')),false);
  assert.match(run('Status').stdout,/BRIDGE_RUNNING/);
  const stopped=run('Stop');assert.equal(stopped.status,0,stopped.stdout+stopped.stderr);assert.equal(fs.existsSync(pidFile),false);
  // Even a forged PID/start-time record cannot stop another Node app whose
  // command line does not run the exact managed bridge script.
  unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  const ticks=spawnSync('powershell.exe',['-NoProfile','-Command',`[string](Get-Process -Id ${unrelated.pid}).StartTime.ToUniversalTime().Ticks`],{encoding:'utf8',windowsHide:true});
  fs.writeFileSync(pidFile,JSON.stringify({processId:unrelated.pid,startedTicks:ticks.stdout.trim(),bridgePath:path.join(app,'bridge.js')}));
  assert.equal(run('Stop').status,0);assert.equal(unrelated.exitCode,null);assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
  const logs=fs.readFileSync(path.join(privateDir,'runtime','bridge.out.log'),'utf8');assert.match(logs,/FAKE_BRIDGE_NO_SQL/);
  assert.equal(JSON.parse(fs.readFileSync(configPath,'utf8')).applyEnabled,false);
});

test('BAT launchers target only the lifecycle manager with explicit actions and process-scoped RemoteSigned',()=>{
  for(const [name,action] of [['start-bogam-bridge','Start'],['stop-bogam-bridge','Stop'],['restart-bogam-bridge','Restart'],['status-bogam-bridge','Status'],['enable-bogam-startup','EnableStartup'],['disable-bogam-startup','DisableStartup']]){
    const text=fs.readFileSync(path.join(__dirname,'..',name+'.bat'),'utf8');
    assert.match(text,new RegExp(`-Action ${action}`));assert.match(text,/manage-bridge\.ps1/);assert.match(text,/-ExecutionPolicy RemoteSigned/);
    assert.doesNotMatch(text,/taskkill|sqlservr|SQLEXPRESS|--check|--inspect|--diagnose|schtasks|Bypass/i);
  }
});
