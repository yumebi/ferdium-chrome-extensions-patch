#!/usr/bin/env node
/**
 * apply-chrome-extensions-installed.js
 *
 * インストール版 Ferdium の app.asar に Chrome拡張機能サポートを追加します。
 * バージョンアップ後に再実行するだけでパッチが当たります。
 *
 * 使い方:
 *   node apply-chrome-extensions-installed.js           <- パッチ適用
 *   node apply-chrome-extensions-installed.js --check   <- 適用済みか確認のみ
 *   node apply-chrome-extensions-installed.js --revert  <- 元の asar に戻す
 *
 * 必要環境: Node.js (Ferdium と同じもの), @electron/asar (このスクリプトが自動インストール)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ─── カラー出力 ───────────────────────────────────────────────────────────────
const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};
const ok   = m => console.log(c.green('  ✔ ') + m);
const fail = m => console.log(c.red('  ✘ ') + m);
const info = m => console.log(c.cyan('  → ') + m);
const warn = m => console.log(c.yellow('  ! ') + m);

// ─── @electron/asar の取得 ────────────────────────────────────────────────────
function requireAsar() {
  // pnpm のシンボリックリンクは Windows で解決できないため、
  // npm で独立インストールした場所を使用する。
  const toolDir = path.join(os.tmpdir(), 'ferdium-asar-tool');
  const asarPath = path.join(toolDir, 'node_modules', '@electron', 'asar');

  if (!fs.existsSync(asarPath)) {
    warn('@electron/asar をインストール中（初回のみ）...');
    fs.mkdirSync(toolDir, { recursive: true });
    // package.json がないと npm がエラーになるため作成
    if (!fs.existsSync(path.join(toolDir, 'package.json'))) {
      fs.writeFileSync(path.join(toolDir, 'package.json'), '{"name":"asar-tool","private":true}');
    }
    execSync('npm install @electron/asar --save --prefix "' + toolDir + '"', {
      stdio: 'inherit',
      shell: true,
    });
    ok('@electron/asar インストール完了');
  }

  // lib/asar.js を直接ロード（Node.js 24 の exports フィールド問題を回避）
  const candidates = ['lib/asar.js', 'index.js', 'lib/index.js'];
  for (const entry of candidates) {
    const full = path.join(asarPath, entry);
    if (fs.existsSync(full)) return require(full);
  }
  throw new Error('@electron/asar のエントリポイントが見つかりません: ' + asarPath);
}

// ─── Ferdium のインストール場所を探す ─────────────────────────────────────────
function findFerdiumAsar() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ferdium', 'resources', 'app.asar'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ferdium', 'resources', 'app.asar'),
    'C:\\Program Files\\Ferdium\\resources\\app.asar',
    'C:\\Program Files (x86)\\Ferdium\\resources\\app.asar',
  ];

  // レジストリからも探す (Windows)
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "Ferdium" /t REG_SZ 2>nul',
        { encoding: 'utf8' }
      );
      const m = out.match(/DisplayIcon\s+REG_SZ\s+(.+?)(?:,\d+)?\r?\n/);
      if (m) {
        const exePath = m[1].trim();
        candidates.unshift(path.join(path.dirname(exePath), 'resources', 'app.asar'));
      }
    } catch (_) {}
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── asar 内のファイル内容を読む (解凍不要) ────────────────────────────────────
function readAsarFile(asarBuf, headerSize, header, filePath) {
  const parts = filePath.split('/').filter(Boolean);
  let node = header;
  for (const k of parts) {
    node = node.files?.[k];
    if (!node) return null;
  }
  if (node.files) return null; // ディレクトリ
  const offset = 16 + headerSize + parseInt(node.offset);
  return asarBuf.slice(offset, offset + node.size).toString('utf8');
}

// ─── パッチが適用済みかチェック ────────────────────────────────────────────────
const PATCH_MARKER = '/* chrome-extensions-patch-v1 */';

// ─── 新規ファイルの内容 ────────────────────────────────────────────────────────

/**
 * extensions-main.js
 * メインプロセスで動く完全自己完結モジュール。
 * Ferdium の内部クラスを使わず fs で直接 extensions.json を読み書きする。
 * 起動時に自動更新チェック、IPC で手動チェックも対応。
 */
const EXTENSIONS_MAIN_JS = `${PATCH_MARKER}
'use strict';
const {app,ipcMain,dialog,session,webContents,BrowserWindow}=require('electron');
const fs=require('fs');
const path=require('path');
const os=require('os');
const crypto=require('crypto');
const https=require('https');
const http=require('http');
const {execSync}=require('child_process');

function settingsPath(){
  return path.join(app.getPath('userData'),'config','extensions.json');
}
function readConfig(){
  try{return JSON.parse(fs.readFileSync(settingsPath(),'utf8'));}
  catch(e){return{paths:[],disabled:[]};}
}
function writeConfig(cfg){
  const f=settingsPath();
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f,JSON.stringify(cfg,null,2),'utf8');
}
function readPaths(){return readConfig().paths||[];}
function writePaths(paths){const cfg=readConfig();cfg.paths=paths;writeConfig(cfg);}
function readDisabled(){return readConfig().disabled||[];}
function readManifest(extPath){
  try{
    const m=JSON.parse(fs.readFileSync(path.join(extPath,'manifest.json'),'utf8'));
    return{path:extPath,name:m.name||extPath,version:m.version||'?',description:m.description||'',manifestVersion:m.manifest_version??2};
  }catch(e){return{path:extPath,name:extPath,version:'?',description:'',manifestVersion:2};}
}
async function loadIntoAllSessions(extPath){
  const sessions=new Set([session.defaultSession]);
  for(const wc of webContents.getAllWebContents()){
    if(wc.getType()==='webview')sessions.add(wc.session);
  }
  await Promise.all([...sessions].map(s=>
    s.loadExtension(extPath,{allowFileAccess:true}).catch(()=>{})
  ));
  for(const wc of webContents.getAllWebContents()){
    if(wc.getType()==='webview'&&!wc.isDestroyed())wc.reload();
  }
}
async function unloadFromAllSessions(extPath){
  const sessions=new Set([session.defaultSession]);
  for(const wc of webContents.getAllWebContents()){
    if(wc.getType()==='webview')sessions.add(wc.session);
  }
  for(const ses of sessions){
    try{
      const exts=ses.getAllExtensions();
      const ext=exts.find(function(e){return e.path===extPath;});
      if(ext)ses.removeExtension(ext.id);
    }catch(_){}
  }
  for(const wc of webContents.getAllWebContents()){
    if(wc.getType()==='webview'&&!wc.isDestroyed())wc.reload();
  }
}

// ── 自動更新ロジック ────────────────────────────────────────────────────────

// manifest.json の key（base64 DER 公開鍵）から Chrome Web Store 拡張機能 ID を計算
function computeExtId(key){
  const keyBytes=Buffer.from(key,'base64');
  const hash=crypto.createHash('sha256').update(keyBytes).digest();
  const abc='abcdefghijklmnop';
  return Array.from(hash.slice(0,16)).map(function(b){return abc[b>>4]+abc[b&0xf];}).join('');
}

// HTTP/HTTPS GET（リダイレクト追跡）
function httpGet(url,depth){
  depth=depth||0;
  return new Promise(function(resolve,reject){
    if(depth>5)return reject(new Error('Too many redirects'));
    const client=url.startsWith('https')?https:http;
    const req=client.get(url,{headers:{'User-Agent':'Mozilla/5.0'}},function(res){
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){
        res.resume();
        return httpGet(res.headers.location,depth+1).then(resolve,reject);
      }
      const chunks=[];
      res.on('data',function(c){chunks.push(c);});
      res.on('end',function(){resolve({status:res.statusCode,buffer:Buffer.concat(chunks)});});
      res.on('error',reject);
    });
    req.on('error',reject);
    req.setTimeout(30000,function(){req.destroy();reject(new Error('Timeout'));});
  });
}

// CRX3 バイナリから ZIP 部分を取り出す
function crxToZip(buf){
  if(buf.slice(0,4).toString()!=='Cr24')throw new Error('Not a CRX file');
  const headerSize=buf.readUInt32LE(8);
  return buf.slice(12+headerSize);
}

// ZIP バッファをディレクトリへ展開（Windows: PowerShell / その他: unzip）
function extractZip(zipBuf,destDir){
  const tmp=path.join(os.tmpdir(),'ferdium-ext-upd-'+Date.now()+'.zip');
  fs.writeFileSync(tmp,zipBuf);
  try{
    if(process.platform==='win32'){
      execSync('powershell -NoProfile -Command "Expand-Archive -LiteralPath $env:_EXT_ZIP -DestinationPath $env:_EXT_DIR -Force"',
        {timeout:60000,env:Object.assign({},process.env,{_EXT_ZIP:tmp,_EXT_DIR:destDir})});
    }else{
      execSync('unzip -o "'+tmp+'" -d "'+destDir+'"',{timeout:60000});
    }
  }finally{try{fs.unlinkSync(tmp);}catch(_){}}
}

// ディレクトリ再帰コピー
function copyDir(src,dest){
  fs.mkdirSync(dest,{recursive:true});
  for(const item of fs.readdirSync(src,{withFileTypes:true})){
    const s=path.join(src,item.name),d=path.join(dest,item.name);
    if(item.isDirectory())copyDir(s,d);else fs.copyFileSync(s,d);
  }
}

// バージョン比較（a>b:1, a<b:-1, equal:0）
function cmpVer(a,b){
  const pa=String(a||'0').split('.').map(Number);
  const pb=String(b||'0').split('.').map(Number);
  for(let i=0;i<Math.max(pa.length,pb.length);i++){
    const na=pa[i]||0,nb=pb[i]||0;
    if(na>nb)return 1;if(na<nb)return -1;
  }
  return 0;
}

// 1つの拡張機能を更新チェック＆適用
async function checkAndUpdate(extPath){
  let manifest;
  try{manifest=JSON.parse(fs.readFileSync(path.join(extPath,'manifest.json'),'utf8'));}
  catch(e){return{status:'error',msg:'manifest読み込み失敗'};}
  // CRX3ではmanifest内にkeyが含まれないため、ディレクトリ名をIDとして使うフォールバック
  let extId;
  if(manifest.key){
    extId=computeExtId(manifest.key);
  }else{
    const dirName=path.basename(extPath);
    if(/^[a-z]{32}$/.test(dirName)){extId=dirName;}
    else{return{status:'skip',msg:'CWSキーなし（手動更新が必要）'};}
  }
  const curVer=manifest.version||'0';
  const updateUrl='https://update.googleapis.com/service/update2/crx?response=redirect&prodversion=120.0.0.0&acceptformat=crx3&x=id%3D'+extId+'%26installsource%3Dondemand%26uc';
  let crxBuf;
  try{
    const res=await httpGet(updateUrl);
    if(res.status!==200||res.buffer.length<12)return{status:'up-to-date',version:curVer};
    crxBuf=res.buffer;
  }catch(e){return{status:'error',msg:e.message};}
  let zipBuf;
  try{zipBuf=crxToZip(crxBuf);}
  catch(e){return{status:'error',msg:'CRX解析失敗: '+e.message};}
  const tmpDir=path.join(os.tmpdir(),'ferdium-ext-upd-'+Date.now());
  try{
    fs.mkdirSync(tmpDir,{recursive:true});
    extractZip(zipBuf,tmpDir);
    const newManifest=JSON.parse(fs.readFileSync(path.join(tmpDir,'manifest.json'),'utf8'));
    const newVer=newManifest.version||'0';
    if(cmpVer(newVer,curVer)>0){
      copyDir(tmpDir,extPath);
      return{status:'updated',version:newVer,oldVersion:curVer};
    }
    return{status:'up-to-date',version:curVer};
  }catch(e){
    return{status:'error',msg:e.message};
  }finally{
    try{fs.rmSync(tmpDir,{recursive:true,force:true});}catch(_){}
  }
}

// 全拡張機能を並列で更新チェック
async function updateAllExtensions(){
  const paths=readPaths();
  const results={};
  await Promise.all(paths.map(async function(p){
    results[p]=await checkAndUpdate(p).catch(function(e){return{status:'error',msg:e.message};});
  }));
  return results;
}

// 更新されたものをセッションにリロード
async function reloadUpdatedExtensions(results){
  const updated=Object.entries(results)
    .filter(function(entry){return entry[1].status==='updated';})
    .map(function(entry){return entry[0];});
  for(const p of updated){await loadIntoAllSessions(p).catch(function(){});}
}

// ── CWS インストール ──────────────────────────────────────────────────────────

// CWS URL または 32 文字 ID から拡張機能 ID を抽出
// ※ テンプレートリテラル内では \\/ がコメント化するため split で処理
function extractExtId(input){
  if(!input)return null;
  input=input.trim();
  if(/^[a-z]{32}$/.test(input))return input;
  const parts=input.split('/');
  for(const p of parts){if(/^[a-z]{32}$/.test(p))return p;}
  return null;
}

// CWS から CRX をダウンロードして指定ディレクトリに展開・登録
async function installExtensionById(id){
  const extDir=path.join(app.getPath('userData'),'extensions',id);
  const downloadUrl='https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0.0.0&acceptformat=crx3&x=id%3D'+id+'%26installsource%3Dondemand%26uc';
  let crxBuf;
  try{
    const res=await httpGet(downloadUrl);
    if(res.status!==200||res.buffer.length<12)return{success:false,error:'ダウンロード失敗（IDが正しいか確認してください）'};
    crxBuf=res.buffer;
  }catch(e){return{success:false,error:'ダウンロードエラー: '+e.message};}
  let zipBuf;
  try{zipBuf=crxToZip(crxBuf);}
  catch(e){return{success:false,error:'CRX解析失敗: '+e.message};}
  try{
    fs.mkdirSync(extDir,{recursive:true});
    extractZip(zipBuf,extDir);
    if(!fs.existsSync(path.join(extDir,'manifest.json'))){
      fs.rmSync(extDir,{recursive:true,force:true});
      return{success:false,error:'manifest.json が見つかりません'};
    }
    const paths=readPaths();
    if(!paths.includes(extDir))writePaths([...paths,extDir]);
    await loadIntoAllSessions(extDir);
    return{success:true,path:extDir};
  }catch(e){
    try{fs.rmSync(extDir,{recursive:true,force:true});}catch(_){}
    return{success:false,error:e.message};
  }
}

// ── イベント登録 ────────────────────────────────────────────────────────────

// セッション作成時に拡張機能をロード（無効なものはスキップ）
app.on('session-created',function(ses){
  const disabled=readDisabled();
  for(const extPath of readPaths()){
    if(!disabled.includes(extPath))
      ses.loadExtension(extPath,{allowFileAccess:true}).catch(function(){});
  }
});

// IPC ハンドラ登録
app.whenReady().then(function(){
  ipcMain.handle('get-extensions',function(){
    const disabled=readDisabled();
    return readPaths().map(function(p){
      const m=readManifest(p);
      m.enabled=!disabled.includes(p);
      return m;
    });
  });

  // 有効/無効トグル
  ipcMain.handle('toggle-extension',async function(_,extPath){
    const cfg=readConfig();
    const disabled=cfg.disabled||[];
    const isDisabled=disabled.includes(extPath);
    if(isDisabled){
      cfg.disabled=disabled.filter(function(p){return p!==extPath;});
      writeConfig(cfg);
      await loadIntoAllSessions(extPath);
    }else{
      cfg.disabled=[...disabled,extPath];
      writeConfig(cfg);
      await unloadFromAllSessions(extPath);
    }
    return{enabled:isDisabled};
  });

  // メモリ使用量取得（app.getAppMetrics() で同期取得 → 確実に動作）
  ipcMain.handle('get-memory-usage',function(){
    // pid → webContents 情報のマップを構築
    const pidMap={};
    for(const wc of webContents.getAllWebContents()){
      if(wc.isDestroyed())continue;
      try{
        const pid=wc.getOSProcessId();
        if(pid)pidMap[pid]={url:wc.getURL(),title:wc.getTitle(),wcType:wc.getType()};
      }catch(_){}
    }
    // app.getAppMetrics() でプロセスごとのメモリを同期取得
    const metrics=app.getAppMetrics();
    return metrics
      .filter(function(m){return m.memory;})
      .map(function(m){
        const wc=pidMap[m.pid]||{};
        // Windows: privateBytes, macOS/Linux: workingSetSize (いずれも KB)
        const kb=(m.memory.privateBytes!=null?m.memory.privateBytes:m.memory.workingSetSize)||0;
        return{
          pid:m.pid,
          processType:m.type,
          url:wc.url||'',
          title:wc.title||'',
          wcType:wc.wcType||'',
          privateMB:Math.round(kb/1024*10)/10,
        };
      })
      .filter(function(r){return r.privateMB>0;})
      .sort(function(a,b){return b.privateMB-a.privateMB;});
  });

  ipcMain.handle('install-extension',async function(){
    const r=await dialog.showOpenDialog({
      title:'Select Chrome Extension Folder (unpacked)',
      properties:['openDirectory'],
    });
    if(r.canceled||!r.filePaths.length)return null;
    const extPath=r.filePaths[0];
    if(!fs.existsSync(path.join(extPath,'manifest.json'))){
      await dialog.showMessageBox({type:'error',title:'Invalid Extension',
        message:'The selected folder does not contain a manifest.json file.'});
      return null;
    }
    const paths=readPaths();
    if(!paths.includes(extPath))writePaths([...paths,extPath]);
    await loadIntoAllSessions(extPath);
    return extPath;
  });

  ipcMain.handle('remove-extension',function(_,extPath){
    const cfg=readConfig();
    cfg.paths=(cfg.paths||[]).filter(function(p){return p!==extPath;});
    cfg.disabled=(cfg.disabled||[]).filter(function(p){return p!==extPath;});
    writeConfig(cfg);
  });

  // CWS URL または ID から拡張機能をインストール
  ipcMain.handle('install-extension-by-id',async function(_,input){
    const id=extractExtId(input);
    if(!id)return{success:false,error:'有効な CWS URL または 32 文字の拡張機能 ID を入力してください'};
    const extDir=path.join(app.getPath('userData'),'extensions',id);
    if(readPaths().includes(extDir)){
      // 既にインストール済み → 更新チェックを行う
      const result=await checkAndUpdate(extDir);
      if(result.status==='updated'){await loadIntoAllSessions(extDir).catch(function(){});return{success:true,path:extDir,msg:'更新しました: v'+result.oldVersion+' → v'+result.version};}
      if(result.status==='up-to-date')return{success:true,path:extDir,msg:'最新版 (v'+result.version+') は既にインストール済みです'};
      return{success:false,error:'更新失敗: '+(result.msg||'')};
    }
    return installExtensionById(id);
  });

  // 手動更新チェック（UI の「更新確認」ボタンから呼ばれる）
  ipcMain.handle('check-extension-updates',async function(){
    const results=await updateAllExtensions();
    await reloadUpdatedExtensions(results);
    return results;
  });

  // 起動10秒後にバックグラウンドで自動更新チェック
  setTimeout(async function(){
    if(!readPaths().length)return;
    try{
      const results=await updateAllExtensions();
      await reloadUpdatedExtensions(results);
      const updatedCount=Object.values(results).filter(function(r){return r.status==='updated';}).length;
      if(updatedCount>0){
        const wins=BrowserWindow.getAllWindows();
        if(wins.length)wins[0].webContents.send('extensions-auto-updated',results);
      }
    }catch(_){}
  },10000);
});
`;

/**
 * ExtensionsScreen.js
 * 完全自己完結の UI コンポーネント。
 * React + electron (ipcRenderer) のみ使用。外部依存なし。
 * 手動「更新確認」ボタン + 起動時自動更新通知に対応。
 */
const EXTENSIONS_SCREEN_JS = `/* chrome-extensions-patch-v1 */
'use strict';
Object.defineProperty(exports,'__esModule',{value:true});
const React=require('react');
const electron=require('electron');
const ipcRenderer=electron.ipcRenderer;
const shell=electron.shell;

const CWS_URL='https://chromewebstore.google.com';

// CSS クラスに一切依存しない完全インラインスタイル版
// flex:1 1 0 + minHeight:0 で Ferdium の flex コンテナ内に正しく収まる
function ExtensionsScreen(){
  const[exts,setExts]=React.useState([]);
  const[updateStatus,setUpdateStatus]=React.useState({});
  const[checking,setChecking]=React.useState(false);
  const[showCws,setShowCws]=React.useState(false);
  const[cwsInput,setCwsInput]=React.useState('');
  const[installing,setInstalling]=React.useState(false);
  const[installResult,setInstallResult]=React.useState(null);
  const[memUsage,setMemUsage]=React.useState(null);
  const[loadingMem,setLoadingMem]=React.useState(false);

  const reload=function(){return ipcRenderer.invoke('get-extensions').then(setExts).catch(function(){});};

  React.useEffect(function(){
    reload();
    const onAutoUpdated=function(_,results){setUpdateStatus(results);reload();};
    ipcRenderer.on('extensions-auto-updated',onAutoUpdated);
    return function(){ipcRenderer.removeListener('extensions-auto-updated',onAutoUpdated);};
  },[]);

  const toggleExt=async function(p){
    await ipcRenderer.invoke('toggle-extension',p);
    reload();
  };

  const fetchMemory=async function(){
    setLoadingMem(true);
    try{const r=await ipcRenderer.invoke('get-memory-usage');setMemUsage(r);}
    catch(e){setMemUsage([]);}
    finally{setLoadingMem(false);}
  };

  const addFolder=async function(){
    const r=await ipcRenderer.invoke('install-extension');
    if(r!=null)reload();
  };

  const remove=async function(p){
    await ipcRenderer.invoke('remove-extension',p);
    setUpdateStatus(function(s){const n=Object.assign({},s);delete n[p];return n;});
    reload();
  };

  const checkUpdates=async function(){
    setChecking(true);setUpdateStatus({});
    try{const results=await ipcRenderer.invoke('check-extension-updates');setUpdateStatus(results);reload();}
    catch(e){console.error('Update check failed',e);}
    finally{setChecking(false);}
  };

  const installFromCws=async function(){
    if(!cwsInput.trim())return;
    setInstalling(true);setInstallResult(null);
    try{
      const r=await ipcRenderer.invoke('install-extension-by-id',cwsInput.trim());
      if(r.success){
        setInstallResult({ok:true,msg:r.msg||'インストール完了'});
        setCwsInput('');
        reload();
      }else{
        setInstallResult({ok:false,msg:r.error||'インストール失敗'});
      }
    }catch(e){setInstallResult({ok:false,msg:e.message});}
    finally{setInstalling(false);}
  };

  const mkBtn=function(label,onClick,bg,disabled){
    return React.createElement('button',{
      onClick:onClick,disabled:disabled,
      style:{padding:'6px 16px',cursor:disabled?'not-allowed':'pointer',border:'none',
             borderRadius:'5px',fontSize:'13px',fontWeight:'600',lineHeight:'1.4',
             background:disabled?'rgba(128,128,128,.35)':bg,color:'#fff',opacity:disabled?.65:1,
             flexShrink:0,display:'inline-block'}
    },label);
  };

  const statusBadge=function(st){
    if(!st)return null;
    const cfg=(function(){
      if(st.status==='updated')   return{label:'↑ v'+st.version,color:'#2e7d32'};
      if(st.status==='up-to-date')return{label:'✓ 最新',color:'rgba(80,80,80,.5)'};
      if(st.status==='skip')      return{label:'手動更新',color:'rgba(100,100,100,.4)'};
      if(st.status==='error')     return{label:'✕ エラー',color:'#c62828'};
      return{label:st.status,color:'gray'};
    })();
    return React.createElement('span',{
      style:{fontSize:'11px',padding:'1px 6px',borderRadius:'3px',background:cfg.color,color:'#fff',marginLeft:'4px'},
      title:st.msg||''
    },cfg.label);
  };

  // ─── 本番UI: settings__main / settings__header / settings__body 構成 v11 ─────
  return React.createElement('div',{className:'settings__main'},

    // ── ヘッダー（他の設定画面と同じ span.settings__header-item 構成）────────
    React.createElement('div',{className:'settings__header'},
      React.createElement('span',{className:'settings__header-item'},'拡張機能 (Extensions)')
    ),

    // ── ボディ（スクロール可） ─────────────────────────────────────────────────
    React.createElement('div',{className:'settings__body'},

      // 対応状況の説明
      React.createElement('div',{
        style:{height:'auto',background:'#f0f4ff',border:'1px solid #c5d0f0',borderRadius:'6px',
               padding:'10px 14px',marginBottom:'18px',fontSize:'12px',color:'#444',lineHeight:'1.7'}
      },
        React.createElement('div',{style:{height:'auto',fontWeight:'700',marginBottom:'4px',color:'#3a4a9a',fontSize:'13px'}},
          'ℹ️ 動作する拡張機能について'),
        React.createElement('div',{style:{height:'auto',display:'flex',gap:'24px',flexWrap:'wrap'}},
          React.createElement('div',{style:{height:'auto'}},
            React.createElement('div',{style:{height:'auto',color:'#2a7a2a',fontWeight:'600',marginBottom:'2px'}},'✅ 動作する（可能性が高い）'),
            React.createElement('ul',{style:{margin:'0',paddingLeft:'16px'}},
              React.createElement('li',{},'Content Script（ページへの注入）'),
              React.createElement('li',{},'Manifest V2 拡張機能')
            )
          ),
          React.createElement('div',{style:{height:'auto'}},
            React.createElement('div',{style:{height:'auto',color:'#b05000',fontWeight:'600',marginBottom:'2px'}},'⚠️ 動作しない・制限あり'),
            React.createElement('ul',{style:{margin:'0',paddingLeft:'16px'}},
              React.createElement('li',{},'ツールバーポップアップ (action/browser_action)'),
              React.createElement('li',{},'Manifest V3（Service Worker）'),
              React.createElement('li',{},'chrome.tabs / bookmarks / history 等')
            )
          )
        )
      ),

      // アクションボタン
      React.createElement('div',{style:{height:'auto',display:'flex',flexWrap:'wrap',gap:'8px',marginBottom:'20px'}},
        mkBtn('フォルダを追加',addFolder,'#7266ef'),
        mkBtn(checking?'確認中…':'更新を確認',checkUpdates,'#5d52cc',checking),
        mkBtn(showCws?'▲ 閉じる':'▼ CWSからインストール',function(){setShowCws(function(v){return !v;});;},'#4a42a8')
      ),

      // CWS インストールパネル
      !showCws ? null : React.createElement('div',{
        style:{height:'auto',background:'#f9f9f9',border:'1px solid #e0e0e0',borderRadius:'6px',
               padding:'14px 16px',marginBottom:'20px'}
      },
        React.createElement('label',{style:{display:'block',fontWeight:'600',fontSize:'13px',marginBottom:'8px'}},
          'CWS 拡張機能ID または URL'),
        React.createElement('div',{style:{height:'auto',display:'flex',gap:'8px',alignItems:'center'}},
          React.createElement('input',{
            type:'text',value:cwsInput,
            onChange:function(e){setCwsInput(e.target.value);},
            placeholder:'hkgfoiooedgoednlkkainodhmaeepdn',
            style:{flex:1,height:'34px',padding:'0 10px',border:'1px solid #ccc',
                   borderRadius:'4px',fontSize:'13px',fontFamily:'monospace',boxSizing:'border-box'},
            onKeyDown:function(e){if(e.key==='Enter')installFromCws();}
          }),
          mkBtn(installing?'インストール中…':'インストール',installFromCws,'#7266ef',installing||!cwsInput.trim())
        ),
        !installResult ? null : React.createElement('div',{
          style:{height:'auto',marginTop:'10px',fontSize:'13px',fontWeight:'600',
                 color:installResult.ok?'#2e7d32':'#c62828'}
        },(installResult.ok?'✔ ':'✕ ')+installResult.msg)
      ),

      // 拡張機能リスト
      exts.length===0
        ? React.createElement('p',{style:{color:'#999',fontStyle:'italic',margin:'20px 0'}},
            '拡張機能がありません。「フォルダを追加」で拡張機能ディレクトリを追加してください。')
        : React.createElement('table',{className:'service-table'},
            React.createElement('tbody',{},
              exts.map(function(ext){
                var st=updateStatus[ext.path];
                var enabled=ext.enabled!==false;
                return React.createElement('tr',{key:ext.path,
                  style:{opacity:enabled?1:0.45,transition:'opacity .2s'}
                },
                  React.createElement('td',{},
                    React.createElement('div',{style:{height:'auto',display:'flex',alignItems:'center',flexWrap:'wrap',gap:'6px'}},
                      React.createElement('strong',{style:{fontSize:'14px'}},ext.name),
                      React.createElement('span',{style:{fontSize:'12px',color:'#888'}},'v'+ext.version),
                      st ? statusBadge(st) : null,
                      !enabled ? React.createElement('span',{
                        style:{fontSize:'11px',padding:'1px 6px',borderRadius:'3px',
                               background:'#999',color:'#fff',marginLeft:'2px'}
                      },'無効') : null
                    ),
                    ext.description
                      ? React.createElement('div',{style:{height:'auto',fontSize:'12px',color:'#666',marginTop:'4px'}},ext.description)
                      : null,
                    React.createElement('div',{style:{height:'auto',fontSize:'11px',color:'#bbb',marginTop:'3px',wordBreak:'break-all'}},ext.path)
                  ),
                  React.createElement('td',{style:{width:'130px',textAlign:'right',verticalAlign:'middle',whiteSpace:'nowrap'}},
                    React.createElement('button',{
                      type:'button',
                      onClick:function(){toggleExt(ext.path);},
                      style:{padding:'4px 10px',cursor:'pointer',borderRadius:'4px',fontSize:'12px',
                             marginRight:'6px',border:'1px solid '+(enabled?'#7266ef':'#ccc'),
                             background:enabled?'#7266ef':'#fff',
                             color:enabled?'#fff':'#888'}
                    },enabled?'有効':'無効'),
                    React.createElement('button',{
                      type:'button',
                      onClick:function(){remove(ext.path);},
                      style:{padding:'4px 10px',cursor:'pointer',border:'1px solid #ddd',
                             borderRadius:'4px',fontSize:'12px',background:'#fff',color:'#555'}
                    },'削除')
                  )
                );
              })
            )
          ),

      // ── メモリ使用量セクション ──────────────────────────────────────────────
      React.createElement('div',{style:{height:'auto',marginTop:'28px',borderTop:'1px solid #eee',paddingTop:'18px'}},
        React.createElement('div',{style:{height:'auto',display:'flex',alignItems:'center',gap:'10px',marginBottom:'12px'}},
          React.createElement('span',{style:{fontWeight:'700',fontSize:'14px'}},'📊 メモリ使用量'),
          mkBtn(loadingMem?'取得中…':'更新',fetchMemory,'#5d52cc',loadingMem)
        ),
        !memUsage ? React.createElement('p',{style:{color:'#999',fontSize:'12px',margin:0}},'「更新」ボタンを押すと各サービスのメモリ使用量を表示します。') :
        memUsage.length===0 ? React.createElement('p',{style:{color:'#999',fontSize:'12px',margin:0}},'データを取得できませんでした。') :
        React.createElement('table',{className:'service-table'},
          React.createElement('thead',{},
            React.createElement('tr',{},
              React.createElement('th',{style:{textAlign:'left',fontSize:'12px',color:'#888',fontWeight:'600',paddingBottom:'6px'}},'タイトル / URL'),
              React.createElement('th',{style:{textAlign:'left',fontSize:'12px',color:'#888',fontWeight:'600',paddingBottom:'6px'}},'種別'),
              React.createElement('th',{style:{textAlign:'right',fontSize:'12px',color:'#888',fontWeight:'600',paddingBottom:'6px'}},'プライベート')
            )
          ),
          React.createElement('tbody',{},
            memUsage.map(function(m,i){
              var label=m.title&&m.title!==m.url?m.title:null;
              var domain=m.url.replace(/^https?:\\/\\//,'').replace(/\\/.*/,'').slice(0,40);
              return React.createElement('tr',{key:i},
                React.createElement('td',{style:{fontSize:'12px',maxWidth:'260px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},
                  label ? React.createElement('div',{style:{height:'auto',fontWeight:'600',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},label) : null,
                  React.createElement('div',{style:{height:'auto',color:'#aaa',fontSize:'11px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},domain||m.url)
                ),
                React.createElement('td',{style:{fontSize:'11px',color:'#888'}},(m.wcType==='webview'?'サービス':m.processType||'')),
                React.createElement('td',{style:{textAlign:'right',fontSize:'12px',fontWeight:'600',
                  color:m.privateMB>200?'#c62828':m.privateMB>100?'#e65100':'#2e7d32'}},
                  m.privateMB+' MB')
              );
            })
          )
        )
      )

    ) // settings__body
  ); // settings__main
}

exports.default=ExtensionsScreen;
`;

// ─── メイン処理 ────────────────────────────────────────────────────────────────

async function applyPatch(asarPath) {
  const asar = requireAsar();
  const backupPath = asarPath + '.backup';

  console.log('');
  console.log(c.bold('═══════════════════════════════════════════════════'));
  console.log(c.bold(' Chrome Extensions Patch for Ferdium (インストール版)'));
  console.log(c.bold('═══════════════════════════════════════════════════'));
  console.log('');
  info('対象: ' + asarPath);
  console.log('');

  // バックアップ
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(asarPath, backupPath);
    ok('バックアップ作成: ' + path.basename(backupPath));
  } else {
    warn('バックアップは既に存在します: ' + path.basename(backupPath));
  }

  // 一時ディレクトリに展開
  const tmpDir = path.join(os.tmpdir(), 'ferdium-patch-' + Date.now());
  console.log('');
  info('asar を展開中...');
  asar.extractAll(asarPath, tmpDir);
  ok('展開完了: ' + tmpDir);

  let errors = 0;

  // ── 1. extensions-main.js を追加（または更新） ────────────────────────────
  console.log('');
  console.log(c.bold('【新規ファイルの追加】'));
  {
    const mainFile = path.join(tmpDir, 'extensions-main.js');
    const existing = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf8') : '';
    const isLatest = existing.includes(PATCH_MARKER)
      && existing.includes('check-extension-updates')
      && existing.includes('install-extension-by-id')
      && existing.includes("input.split('/')")    // extractExtId の修正版を確認
      && existing.includes('test(dirName)')        // CRX3 dirName フォールバック版を確認
      && existing.includes('toggle-extension')      // 有効/無効トグル版を確認
      && existing.includes('getAppMetrics');        // app.getAppMetrics() 版を確認
    if (isLatest) {
      warn('スキップ（最新版）: extensions-main.js');
    } else if (existing.includes(PATCH_MARKER)) {
      fs.writeFileSync(mainFile, EXTENSIONS_MAIN_JS, 'utf8');
      ok('更新: extensions-main.js');
    } else {
      fs.writeFileSync(mainFile, EXTENSIONS_MAIN_JS, 'utf8');
      ok('作成: extensions-main.js');
    }
  }

  // ── 2. ExtensionsScreen.js を追加（または更新） ────────────────────────────
  {
    const destPath = path.join(tmpDir, 'containers/settings/ExtensionsScreen.js');
    const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : '';
    const isLatest = existing.includes(PATCH_MARKER)
      && existing.includes('check-extension-updates')
      && existing.includes('install-extension-by-id')
      && existing.includes("'settings__main'")             // CSS class 構成版の識別子
      && existing.includes("'settings__body'")             // CSS class 構成版の識別子
      && existing.includes("settings__body 構成 v11")      // バージョン識別子
      && !existing.includes('DBG v3b')                    // デバッグ版でないことを確認
      && !existing.includes('DBG v2');                    // デバッグ版でないことを確認
    if (isLatest) {
      warn('スキップ（最新版）: containers/settings/ExtensionsScreen.js');
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, EXTENSIONS_SCREEN_JS, 'utf8');
      ok(existing.includes(PATCH_MARKER)
        ? '更新: containers/settings/ExtensionsScreen.js'
        : '作成: containers/settings/ExtensionsScreen.js');
    }
  }

  // ── 3. index.js に require を追加 ─────────────────────────────────────────
  console.log('');
  console.log(c.bold('【既存ファイルへのパッチ適用】'));
  {
    const file = path.join(tmpDir, 'index.js');
    let content = fs.readFileSync(file, 'utf8');
    if (content.includes(PATCH_MARKER)) {
      warn('スキップ（適用済み）: index.js — extensions-main の読み込み');
    } else if (content.startsWith('"use strict";')) {
      content = `"use strict";require('./extensions-main');${PATCH_MARKER}\n` + content.slice('"use strict";'.length);
      fs.writeFileSync(file, content, 'utf8');
      ok('パッチ適用: index.js — extensions-main の読み込み');
    } else {
      fail('パッチ失敗: index.js — "use strict"; が見つかりません');
      errors++;
    }
  }

  // ── 4. routes.js に ExtensionsScreen を追加 ───────────────────────────────
  {
    const file = path.join(tmpDir, 'routes.js');
    let content = fs.readFileSync(file, 'utf8');

    const hasOldEagerRequire = /var ExtScreen_=\{default:require\(/.test(content);
    const hasExtensionsRoute = content.includes('/settings/extensions');

    if (hasExtensionsRoute && !hasOldEagerRequire) {
      // 正しいパッチ（遅延 require）が既に適用済み
      // ただし catch ブロックがエラー表示版でなければ更新する
      if (content.includes('catch(e_){return null}')) {
        const jsxFnMatchInner = content.match(/\(0,([^(]+)\)\([^.]+\.Route,\{path:"\/settings\/extensions"/);
        const jsxFnInner = jsxFnMatchInner ? jsxFnMatchInner[1] : 'e.jsx';
        content = content.replace(
          /catch\(e_\)\{return null\}/g,
          `catch(e_){console.error('[EXT-SCREEN]',e_);return (0,${jsxFnInner})('div',{style:{color:'#c00',padding:'16px',fontSize:'14px',fontFamily:'monospace',background:'#fff0f0',whiteSpace:'pre-wrap'}},String(e_))}`
        );
        fs.writeFileSync(file, content, 'utf8');
        ok('更新: routes.js — catch を error-display に変更');
      } else {
        warn('スキップ（最新版）: routes.js — ExtensionsScreen ルート');
      }

    } else if (hasOldEagerRequire) {
      // 旧パッチの壊れた eager require を自動修正（--revert 不要）
      info('routes.js: 旧パッチ（eager require）を検出 → 遅延 require に修正します');

      // a) トップレベルの var ExtScreen_=... を除去
      content = content.replace(/var ExtScreen_=\{default:require\("[^"]+"\)\.default\};/, '');

      if (hasExtensionsRoute) {
        // b-1) 既にルートはある: element だけ lazy function に差し替え
        const jsxFnMatch = content.match(/\(0,([^(]+)\)\([^.]+\.Route,\{path:"\/settings\/extensions"/);
        const jsxFn = jsxFnMatch ? jsxFnMatch[1] : 'e.jsx';
        content = content.replace(
          /element:\(0,[^(]+\)\(ExtScreen_\.default,\{\}\)/,
          `element:(0,${jsxFn})(function(){try{return (0,${jsxFn})(require("./containers/settings/ExtensionsScreen").default,{})}catch(e_){console.error('[EXT-SCREEN]',e_);return (0,${jsxFn})('div',{style:{color:'#c00',padding:'16px',fontSize:'14px',fontFamily:'monospace',background:'#fff0f0',whiteSpace:'pre-wrap'}},String(e_))}},{})`
        );
      } else {
        // b-2) ルートそのものもまだない: 新規挿入
        const routeRe = /(\(0,[^(]+\)\([^.]+\.Route,\{path:"\/settings\/support",element:\(0,[^(]+\)\([^.]+\.default,\{\.\.\.this\.props\}\)\}\))/;
        const routeMatch = content.match(routeRe);
        if (!routeMatch) {
          fail('パッチ失敗: routes.js — "/settings/support" Route が見つかりません（バージョン変更？）');
          errors++;
        } else {
          const supportRoute = routeMatch[1];
          const jsxFnMatch = supportRoute.match(/\(0,([^(]+)\)\([^.]+\.Route/);
          const jsxFn = jsxFnMatch ? jsxFnMatch[1] : 'e.jsx';
          const extensionsRoute = supportRoute
            .replace('"/settings/support"', '"/settings/extensions"')
            .replace(
              /element:\(0,[^(]+\)\([^.]+\.default,\{\.\.\.this\.props\}\)/,
              `element:(0,${jsxFn})(function(){try{return (0,${jsxFn})(require("./containers/settings/ExtensionsScreen").default,{})}catch(e_){console.error('[EXT-SCREEN]',e_);return (0,${jsxFn})('div',{style:{color:'#c00',padding:'16px',fontSize:'14px',fontFamily:'monospace',background:'#fff0f0',whiteSpace:'pre-wrap'}},String(e_))}},{})`
            );
          content = content.replace(supportRoute, extensionsRoute + ',' + supportRoute);
        }
      }
      fs.writeFileSync(file, content, 'utf8');
      ok('修正完了: routes.js — 遅延 require に変換');

    } else {
      // 未適用: 新規パッチ適用
      const routeRe = /(\(0,[^(]+\)\([^.]+\.Route,\{path:"\/settings\/support",element:\(0,[^(]+\)\([^.]+\.default,\{\.\.\.this\.props\}\)\}\))/;
      const routeMatch = content.match(routeRe);

      if (!routeMatch) {
        fail('パッチ失敗: routes.js — "/settings/support" Route が見つかりません（バージョン変更？）');
        errors++;
      } else {
        const supportRoute = routeMatch[1];
        // JSX ランタイムの変数名を support Route から抽出 (例: "e.jsx")
        // ★ require はファイル先頭で eager ロードせず、Route の element 内で遅延評価する。
        //    こうすることで ExtensionsScreen がエラーを起こしても routes.js 全体が壊れない。
        const jsxFnMatch = supportRoute.match(/\(0,([^(]+)\)\([^.]+\.Route/);
        const jsxFn = jsxFnMatch ? jsxFnMatch[1] : 'e.jsx';

        const extensionsRoute = supportRoute
          .replace('"/settings/support"', '"/settings/extensions"')
          .replace(
            /element:\(0,[^(]+\)\([^.]+\.default,\{\.\.\.this\.props\}\)/,
            `element:(0,${jsxFn})(function(){try{return (0,${jsxFn})(require("./containers/settings/ExtensionsScreen").default,{})}catch(e_){console.error('[EXT-SCREEN]',e_);return (0,${jsxFn})('div',{style:{color:'#c00',padding:'16px',fontSize:'14px',fontFamily:'monospace',background:'#fff0f0',whiteSpace:'pre-wrap'}},String(e_))}},{})`
          );
        content = content.replace(supportRoute, extensionsRoute + ',' + supportRoute);
        fs.writeFileSync(file, content, 'utf8');
        ok('パッチ適用: routes.js — ExtensionsScreen ルート（遅延 require）');
      }
    }
  }

  // ── 5. SettingsNavigation.js に Extensions を追加 ─────────────────────────
  {
    const file = path.join(tmpDir, 'components/settings/navigation/SettingsNavigation.js');
    let content = fs.readFileSync(file, 'utf8');
    if (content.includes('settings.navigation.extensions')) {
      warn('スキップ（適用済み）: SettingsNavigation.js — Extensions リンク');
    } else {
      const msgTarget = 'releaseNotes:{id:"settings.navigation.releaseNotes"';
      // releasenotes の NavLink を文字列検索で切り出す
      // 安定した目印: to:"/settings/releasenotes" の前後
      const navEndMarker = 'r.releaseNotes)})'; // NavLink の末尾（安定した文字列）
      const navStartSearch = 'to:"/settings/releasenotes"';

      if (!content.includes(msgTarget) || !content.includes(navStartSearch) || !content.includes(navEndMarker)) {
        fail('パッチ失敗: SettingsNavigation.js — 挿入点が見つかりません（バージョン変更？）');
        errors++;
      } else {
        // NavLink の開始位置を特定（to:"/settings/releasenotes" の手前の "(0," を探す）
        const toIdx = content.indexOf(navStartSearch);
        const startIdx = content.lastIndexOf('(0,', toIdx);
        const endIdx = content.indexOf(navEndMarker, toIdx) + navEndMarker.length;
        const releaseNotesNavLink = content.slice(startIdx, endIdx);

        // メッセージ定義を追加（releaseNotes の前に extensions を追加）
        content = content.replace(
          msgTarget,
          `extensions:{id:"settings.navigation.extensions",defaultMessage:"Extensions"},releaseNotes:{id:"settings.navigation.releaseNotes"`
        );
        // releaseNotes NavLink をコピーして extensions 用に書き換え、前に挿入
        const extensionsNavLink = releaseNotesNavLink
          .replace('"/settings/releasenotes"', '"/settings/extensions"')
          .replace('r.releaseNotes', 'r.extensions');
        content = content.replace(releaseNotesNavLink, extensionsNavLink + ',' + releaseNotesNavLink);
        fs.writeFileSync(file, content, 'utf8');
        ok('パッチ適用: SettingsNavigation.js — Extensions リンク');
      }
    }
  }

  // ── 6. asar を再梱包 ──────────────────────────────────────────────────────
  console.log('');
  if (errors > 0) {
    fail(`${errors} 件のパッチが失敗しました。asar は更新されません。`);
    info('一時ディレクトリを削除: ' + tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  info('asar を再梱包中...');
  const unpackedDir = asarPath + '.unpacked';
  const unpackedGlob = fs.existsSync(unpackedDir)
    ? '{node_modules/**,assets/**,recipes/**}'
    : undefined;

  // 既存の asar を置き換え
  await asar.createPackageWithOptions(tmpDir, asarPath, {
    unpackDir: unpackedGlob,
  });
  ok('asar 再梱包完了');

  // 一時ディレクトリを削除
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  console.log(c.green(c.bold('✔ パッチ適用完了！ Ferdium を再起動してください。')));
  console.log('');
}

function checkPatch(asarPath) {
  console.log('');
  console.log(c.bold('【適用状況の確認】'));
  console.log('');
  info('対象: ' + asarPath);
  console.log('');

  const buf = fs.readFileSync(asarPath);
  const hs = buf.readUInt32LE(12);
  const header = JSON.parse(buf.slice(16, 16 + hs).toString());

  function readFile(filePath) {
    const parts = filePath.split('/').filter(Boolean);
    let node = header;
    for (const k of parts) { node = node.files?.[k]; if (!node) return null; }
    if (node.files) return null;
    const offset = 16 + hs + parseInt(node.offset);
    return buf.slice(offset, offset + node.size).toString('utf8');
  }

  const checks = [
    { path: 'extensions-main.js',           marker: PATCH_MARKER,                         desc: 'extensions-main.js' },
    { path: 'index.js',                     marker: PATCH_MARKER,                         desc: 'index.js の require 注入' },
    { path: 'routes.js',                    marker: '/settings/extensions',               desc: 'routes.js の Extension ルート' },
    { path: 'components/settings/navigation/SettingsNavigation.js',
                                            marker: 'settings.navigation.extensions',     desc: 'SettingsNavigation の Extensions リンク' },
    { path: 'containers/settings/ExtensionsScreen.js',
                                            marker: 'ExtensionsScreen',                   desc: 'ExtensionsScreen コンテナ（自己完結版）' },
  ];

  for (const ck of checks) {
    const content = readFile(ck.path);
    if (!content) fail(`ファイルなし: ${ck.path}`);
    else if (content.includes(ck.marker)) ok(`適用済み: ${ck.desc}`);
    else fail(`未適用: ${ck.desc}`);
  }
  console.log('');
}

function revertPatch(asarPath) {
  const backupPath = asarPath + '.backup';
  console.log('');
  console.log(c.bold('【パッチを元に戻す】'));
  console.log('');
  if (!fs.existsSync(backupPath)) {
    fail('バックアップが見つかりません: ' + backupPath);
    process.exit(1);
  }
  fs.copyFileSync(backupPath, asarPath);
  ok('復元完了: ' + path.basename(asarPath));
  console.log('');
  console.log(c.green('元に戻しました。Ferdium を再起動してください。'));
  console.log('');
}

// ─── エントリーポイント ────────────────────────────────────────────────────────
(async () => {
  const arg = process.argv[2];

  const asarPath = findFerdiumAsar();
  if (!asarPath) {
    fail('Ferdium のインストールが見つかりません。');
    fail('以下のいずれかにインストールしてください:');
    fail('  %LOCALAPPDATA%\\Programs\\ferdium\\');
    fail('  C:\\Program Files\\Ferdium\\');
    process.exit(1);
  }

  if (arg === '--check')        checkPatch(asarPath);
  else if (arg === '--revert')  revertPatch(asarPath);
  else                          await applyPatch(asarPath);
})();
