/**
 * Sale Bot BĐS - Entry Point
 * 
 * Multi-account Zalo bot cho sale bất động sản cho thuê.
 * Flow: Login → Quét group → Kết bạn → Gửi hình mời → Kéo vào group
 * 
 * Chạy: bun src/main.ts
 */

import fs from 'node:fs';
import { Hono } from 'hono';
import { accounts, exportAllCredentials, getAllStoredAccounts, initRestore } from './account.js';
import { loadConfig, saveConfig, type BotConfig } from './config.js';
import { startWorker, stopWorker, stopAllWorkers, getWorkersStatus, exportAllProgress, testSendImages } from './worker.js';
import { registerListeners } from './listener.js';
import { pushFilesToGitHub } from './git-sync.js';

/** Check account có source groups không (riêng hoặc chung) */
function hasGroups(accountId: string, config: BotConfig): boolean {
  return (config.accountSourceGroups?.[accountId]?.length || config.sourceGroupLinks.length) > 0;
}

/** Push config + credentials lên GitHub để persist qua deploy */
async function syncToGitHub(reason: string): Promise<void> {
  try {
    const files: Array<{ path: string; content: string }> = [];

    // Config
    const configPath = './data/config.json';
    if (fs.existsSync(configPath)) {
      files.push({ path: 'data/config.json', content: fs.readFileSync(configPath, 'utf-8') });
    }

    // Credentials
    const credsPath = './src/credentials.json';
    if (fs.existsSync(credsPath)) {
      files.push({ path: 'src/credentials.json', content: fs.readFileSync(credsPath, 'utf-8') });
    }

    // Accounts
    const accountsDir = './src/accounts';
    if (fs.existsSync(accountsDir)) {
      for (const f of fs.readdirSync(accountsDir).filter(f => f.endsWith('.json'))) {
        files.push({ path: `src/accounts/${f}`, content: fs.readFileSync(`${accountsDir}/${f}`, 'utf-8') });
      }
    }

    if (files.length > 0) {
      await pushFilesToGitHub(files, `bot: ${reason}`);
    }
  } catch (e: any) {
    console.log(`⚠️ syncToGitHub failed: ${e.message}`);
  }
}

// Track login status cho QR login
const loginStatus = new Map<string, { status: string; error?: string; account?: any; time: string }>();

let config = loadConfig();

// ═══════════════════════════════════════════════════
// API SERVER
// ═══════════════════════════════════════════════════

const app = new Hono();
const port = Number(process.env.PORT) || 3000;
const startTime = Date.now();

// CORS middleware - cho phép gọi API từ mọi nơi
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', '*');
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
});
app.options('*', (c) => new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } }));

// Dashboard HTML
app.get('/dashboard', (c) => {
  return c.html(getDashboardHtml());
});

// Health check
app.get('/', (c) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  return c.json({
    status: 'ok',
    service: 'Sale Bot BĐS',
    uptime: `${uptime}s`,
    accounts: accounts.count(),
    workers: getWorkersStatus(),
  });
});

// ─── Account Management ───

// Danh sách accounts
app.get('/api/accounts', (c) => {
  const list = accounts.list().map(a => ({
    ...a,
    online: accounts.isOnline(a.id),
  }));
  return c.json({ accounts: list });
});

// Thêm account bằng QR
// Step 1: POST /api/accounts/add → tạo QR, trả về qrId
// Step 2: GET /api/accounts/qr/:qrId → xem QR image trên browser để quét
// Step 3: Sau khi quét xong, POST tự động resolve
app.post('/api/accounts/add', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const label = (body as any)?.label || undefined;

  // Tạo QR trong background, trả về ngay qrId để user xem QR
  const qrId = `qr_${Date.now()}`;
  const qrPath = `./data/accounts/${qrId}.png`;

  // Start login process (async, chạy background)
  const loginPromise = accounts.addByQR(label, qrPath);
  loginStatus.set(qrId, { status: 'waiting_scan', time: new Date().toISOString() });

  // Khi login xong → đăng ký listener + start worker + save credentials
  loginPromise.then((result) => {
    if (result.success && result.account) {
      loginStatus.set(qrId, { status: 'success', account: result.account, time: new Date().toISOString() });
      const api = accounts.getApi(result.account.id);
      if (api) {
        console.log(`🎉 Login thành công: ${result.account.name}, đang đăng ký listener...`);
        registerListeners(api, result.account.id, config);
        if (hasGroups(result.account.id, config)) {
          startWorker(api, result.account.id, result.account.name, config);
        }
        // Auto save credentials vào bundled file
        try {
          const stored = getAllStoredAccounts();
          fs.writeFileSync('./src/credentials.json', JSON.stringify(stored, null, 2));
          console.log('💾 Credentials đã lưu vào src/credentials.json');
          syncToGitHub(`add account ${result.account.name}`);
        } catch (e: any) {
          console.log('⚠️ Không lưu được credentials file:', e.message);
        }
      }
    } else {
      loginStatus.set(qrId, { status: 'failed', error: result.error, time: new Date().toISOString() });
      console.log(`❌ Login QR failed: ${result.error}`);
    }
  }).catch((e: any) => {
    loginStatus.set(qrId, { status: 'error', error: e.message, time: new Date().toISOString() });
    console.log(`❌ Login QR crash: ${e.message}`);
  });

  // Chờ 3s để QR file được tạo
  await new Promise(r => setTimeout(r, 3000));

  // Trả về URL để xem QR
  return c.json({
    message: 'QR đã tạo. Mở URL bên dưới trên trình duyệt để quét.',
    qrUrl: `/api/accounts/qr/${qrId}`,
    qrId,
    note: 'Sau khi quét xong, gọi GET /api/accounts để kiểm tra.',
  });
});

// Serve QR image
app.get('/api/accounts/qr/:qrId', (c) => {
  const qrId = c.req.param('qrId');
  const qrPath = `./data/accounts/${qrId}.png`;

  if (!fs.existsSync(qrPath)) {
    return c.json({ error: 'QR not found hoặc đã quét xong' }, 404);
  }

  const buffer = fs.readFileSync(qrPath);
  return new Response(buffer, {
    headers: { 'Content-Type': 'image/png' },
  });
});

// QR page đẹp - mở trên browser để quét
app.get('/api/accounts/qr-page/:qrId', (c) => {
  const qrId = c.req.param('qrId');
  const html = `<!DOCTYPE html>
<html><head><title>Quét QR Zalo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f2f5}
.card{background:white;border-radius:16px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center;max-width:400px}
img{max-width:300px;border-radius:8px;margin:16px 0}
h2{color:#0068ff}p{color:#666}
.status{margin-top:16px;padding:12px;border-radius:8px;background:#e8f5e9;color:#2e7d32;display:none}
</style></head><body>
<div class="card">
<h2>🏠 Sale Bot BĐS</h2>
<p>Mở Zalo trên điện thoại → Quét mã QR bên dưới</p>
<img id="qr" src="/api/accounts/qr/${qrId}" alt="QR Code" />
<p style="font-size:13px;color:#999">QR sẽ tự refresh nếu hết hạn</p>
<div class="status" id="status">✅ Đăng nhập thành công!</div>
</div>
<script>
setInterval(async()=>{
  try{const r=await fetch('/api/accounts/qr/${qrId}');
  if(!r.ok)document.getElementById('status').style.display='block'}catch{}
},3000);
</script></body></html>`;
  return c.html(html);
});

// Login lại 1 account (khi bị expired)
app.post('/api/accounts/:id/login', async (c) => {
  const id = c.req.param('id');
  const result = await accounts.login(id);
  if (result.success) {
    const api = accounts.getApi(id);
    const info = accounts.list().find(a => a.id === id);
    if (api && info) {
      registerListeners(api, id, config);
      if (hasGroups(id, config)) {
        startWorker(api, id, info.name || info.label, config);
      }
    }
  }
  return c.json({ success: result.success, error: result.error });
});

// Login tất cả accounts + start workers
app.post('/api/login-all', async (c) => {
  const result = await accounts.loginAll();
  // Start workers cho tất cả accounts online
  for (const [accountId, api] of accounts.getActiveApis()) {
    const info = accounts.list().find(a => a.id === accountId);
    if (info) {
      registerListeners(api, accountId, config);
      if (hasGroups(accountId, config)) {
        startWorker(api, accountId, info.name || info.label, config);
      }
    }
  }
  return c.json({ ...result, workers: getWorkersStatus() });
});

// Xem status login QR
app.get('/api/accounts/login-status/:qrId', (c) => {
  const qrId = c.req.param('qrId');
  const status = loginStatus.get(qrId);
  if (!status) return c.json({ error: 'QR ID not found' }, 404);
  return c.json(status);
});

// Xem tất cả login status gần đây
app.get('/api/debug/login-status', (c) => {
  const all: any = {};
  for (const [k, v] of loginStatus) all[k] = v;
  return c.json(all);
});

// Xóa account
app.delete('/api/accounts/:id', (c) => {
  const id = c.req.param('id');
  stopWorker(id);
  const removed = accounts.remove(id);
  return c.json({ success: removed });
});

// Gán source groups cho 1 account
app.put('/api/accounts/:id/groups', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const groups: string[] = (body as any)?.groups || [];
  
  if (!config.accountSourceGroups) config.accountSourceGroups = {};
  config.accountSourceGroups[id] = groups;
  saveConfig(config);
  syncToGitHub(`update groups for ${id}`);
  
  // Restart worker cho account này với groups mới
  stopWorker(id);
  const api = accounts.getApi(id);
  const info = accounts.list().find(a => a.id === id);
  if (api && info && groups.length > 0) {
    startWorker(api, id, info.name || info.label, config);
  }
  
  return c.json({ success: true, accountId: id, groups });
});

// Force reset 1 account file trên persistent disk (xóa file cũ, restore từ bundled)
app.post('/api/accounts/:id/reset', (c) => {
  const id = c.req.param('id');
  try {
    // Xóa file cũ trên persistent disk
    const diskPath = `./data/accounts/${id}.json`;
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    // Restore từ bundled
    initRestore();
    // Check result
    const exists = fs.existsSync(diskPath);
    let info = null;
    if (exists) {
      try { info = JSON.parse(fs.readFileSync(diskPath, 'utf-8'))?.info; } catch {}
    }
    return c.json({ success: true, fileExists: exists, info });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── Upload hình mời ───

// Lấy credentials base64 để lưu vào Render env var
app.get('/api/credentials', (c) => {
  const base64 = exportAllCredentials();
  const count = accounts.count();
  return c.json({
    count,
    credentials: base64,
    instruction: 'Copy giá trị credentials → Render Dashboard → Environment → thêm ZALO_CREDENTIALS = <giá trị>',
  });
});

// Lấy credentials dạng JSON (để lưu vào repo)
app.get('/api/credentials/json', (c) => {
  const stored = getAllStoredAccounts();
  return c.json(stored);
});

app.post('/api/upload-image', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('image') as File;
    if (!file) return c.json({ error: 'Không có file' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const imagesDir = './data/images';
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(`${imagesDir}/invite.jpg`, buffer);

    return c.json({ success: true, message: 'Đã lưu hình invite.jpg', size: buffer.length });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Xem hình hiện tại
app.get('/api/invite-image', (c) => {
  const imgPath = './data/images/invite.jpg';
  if (!fs.existsSync(imgPath)) return c.json({ error: 'Chưa có hình' }, 404);
  const buffer = fs.readFileSync(imgPath);
  return new Response(buffer, { headers: { 'Content-Type': 'image/jpeg' } });
});

// ─── Config ───

app.get('/api/config', (c) => c.json(config));

app.put('/api/config', async (c) => {
  const body = await c.req.json();
  config = { ...config, ...(body as Partial<BotConfig>) };
  saveConfig(config);
  syncToGitHub('update config');

  // Restart workers với config mới
  stopAllWorkers();
  startAllWorkers();

  return c.json({ success: true, config });
});

// ─── Workers ───

app.get('/api/workers', (c) => c.json({ workers: getWorkersStatus() }));

// Debug: test restore credentials manually
app.get('/api/debug/test-restore', (c) => {
  try {
    const bundled = './src/credentials.json';
    if (!fs.existsSync(bundled)) return c.json({ error: 'No bundled file' });
    
    const raw = fs.readFileSync(bundled, 'utf-8');
    const firstBytes = Array.from(Buffer.from(raw.substring(0, 5))).join(',');
    const cleaned = raw.replace(/^\uFEFF/, '').replace(/\0/g, '').trim();
    
    let parsed: any;
    try { parsed = JSON.parse(cleaned); } catch (e: any) { return c.json({ error: `Parse failed: ${e.message}`, firstBytes, rawLength: raw.length }); }
    
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const results: any[] = [];
    
    const accountsDir = './data/accounts';
    if (!fs.existsSync(accountsDir)) fs.mkdirSync(accountsDir, { recursive: true });
    
    for (let i = 0; i < arr.length; i++) {
      const data = arr[i];
      const id = data?.info?.id || data?.credentials?.uid;
      const label = data?.info?.label || data?.info?.name;
      if (!id) { results.push({ index: i, error: 'no id', infoKeys: Object.keys(data?.info || {}) }); continue; }
      
      const targetPath = `${accountsDir}/${id}.json`;
      try {
        fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
        const exists = fs.existsSync(targetPath);
        const size = fs.statSync(targetPath).size;
        results.push({ index: i, id, label, written: true, exists, size, path: targetPath });
      } catch (e: any) {
        results.push({ index: i, id, label, written: false, error: e.message });
      }
    }
    
    const allFiles = fs.readdirSync(accountsDir);
    return c.json({ firstBytes, rawLength: raw.length, parsedCount: arr.length, results, accountFiles: allFiles });
  } catch (e: any) {
    return c.json({ error: e.message, stack: e.stack?.substring(0, 300) });
  }
});

// Debug: xem credentials file trên server
app.get('/api/debug/creds-file', (c) => {
  try {
    const bundled = './src/credentials.json';
    const exists = fs.existsSync(bundled);
    let count = 0;
    let ids: string[] = [];
    if (exists) {
      const raw = fs.readFileSync(bundled, 'utf-8');
      // Strip BOM
      const cleaned = raw.replace(/^\uFEFF/, '').replace(/\0/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      count = arr.length;
      ids = arr.map((a: any) => {
        const id = a?.info?.id || a?.credentials?.uid || 'NO_ID';
        const label = a?.info?.label || a?.info?.name || 'NO_NAME';
        return `${id} (${label})`;
      });
    }
    const accountsDir = './data/accounts';
    const files = fs.existsSync(accountsDir) ? fs.readdirSync(accountsDir) : [];
    // Also check each account file content
    const accountDetails = files.filter(f => f.endsWith('.json') && !f.startsWith('qr_')).map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(`${accountsDir}/${f}`, 'utf-8'));
        return { file: f, id: data?.info?.id, status: data?.info?.status, label: data?.info?.label };
      } catch (e: any) {
        return { file: f, error: e.message };
      }
    });
    return c.json({ bundledExists: exists, bundledCount: count, bundledIds: ids, accountFiles: files, accountDetails });
  } catch (e: any) {
    return c.json({ error: e.message });
  }
});

// Force restore 1 account từ credentials.json (bypass persistent disk + bundled accounts)
app.post('/api/accounts/:id/force-restore', (c) => {
  const id = c.req.param('id');
  try {
    const credsFile = './src/credentials.json';
    if (!fs.existsSync(credsFile)) return c.json({ error: 'No credentials.json' }, 404);
    const raw = fs.readFileSync(credsFile, 'utf-8').replace(/^\uFEFF/, '').trim();
    const arr = JSON.parse(raw);
    const account = (Array.isArray(arr) ? arr : [arr]).find((a: any) => a?.info?.id === id);
    if (!account) return c.json({ error: `Account ${id} not found in credentials.json` }, 404);

    // Ghi đè vào data/accounts/
    const targetPath = `./data/accounts/${id}.json`;
    fs.writeFileSync(targetPath, JSON.stringify(account, null, 2));
    return c.json({ success: true, label: account.info.label, status: account.info.status, lastLogin: account.info.lastLoginAt });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Debug: xem bundled accounts trên server
app.get('/api/debug/bundled-accounts', (c) => {
  try {
    const bundledDir = './src/accounts';
    const bundledCreds = './src/credentials.json';
    const result: any = { bundledDir: { exists: false }, credsFile: { exists: false } };

    if (fs.existsSync(bundledDir)) {
      const files = fs.readdirSync(bundledDir);
      result.bundledDir = { exists: true, files };
      result.bundledAccounts = files.filter(f => f.endsWith('.json')).map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(`${bundledDir}/${f}`, 'utf-8'));
          return { file: f, label: data?.info?.label, status: data?.info?.status, lastLogin: data?.info?.lastLoginAt, created: data?.info?.createdAt };
        } catch (e: any) { return { file: f, error: e.message }; }
      });
    }

    if (fs.existsSync(bundledCreds)) {
      const raw = fs.readFileSync(bundledCreds, 'utf-8');
      const cleaned = raw.replace(/^\uFEFF/, '').replace(/\0/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      result.credsFile = { exists: true, count: arr.length };
      result.credsAccounts = arr.map((a: any) => ({
        id: a?.info?.id, label: a?.info?.label, status: a?.info?.status, lastLogin: a?.info?.lastLoginAt
      }));
    }

    // Also show data/accounts
    const dataDir = './data/accounts';
    if (fs.existsSync(dataDir)) {
      result.dataAccounts = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && !f.startsWith('qr_')).map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(`${dataDir}/${f}`, 'utf-8'));
          return { file: f, label: data?.info?.label, status: data?.info?.status, lastLogin: data?.info?.lastLoginAt };
        } catch (e: any) { return { file: f, error: e.message }; }
      });
    }

    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Export progress (để lưu vào repo, tránh mất khi deploy)
app.get('/api/progress', (c) => c.json(exportAllProgress()));

// Sync progress từ server → bundled (src/progress/) để persist qua deploy
app.post('/api/progress/sync', (c) => {
  try {
    const progressDir = './data/progress';
    const bundledDir = './src/progress';
    if (!fs.existsSync(bundledDir)) fs.mkdirSync(bundledDir, { recursive: true });
    
    const files = fs.existsSync(progressDir) 
      ? fs.readdirSync(progressDir).filter(f => f.endsWith('.json'))
      : [];
    
    const synced: string[] = [];
    for (const f of files) {
      fs.copyFileSync(`${progressDir}/${f}`, `${bundledDir}/${f}`);
      synced.push(f);
    }
    
    return c.json({ success: true, synced, message: `Synced ${synced.length} progress files to bundled` });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/api/workers/restart', async (c) => {
  try {
    stopAllWorkers();
    // Re-login all accounts first
    const loginResult = await accounts.loginAll();
    // Then start workers
    for (const [accountId, api] of accounts.getActiveApis()) {
      const info = accounts.list().find(a => a.id === accountId);
      if (info) {
        registerListeners(api, accountId, config);
        if (hasGroups(accountId, config)) {
          startWorker(api, accountId, info.name || info.label, config);
        }
      }
    }
    return c.json({ success: true, login: loginResult, workers: getWorkersStatus() });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Test gửi hình ngay lập tức (bỏ qua schedule, active hours)
// POST /api/test-send?count=2 → gửi hình cho 2 member/account
app.post('/api/test-send', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const count = (body as any)?.count || 2;
  const results: any[] = [];

  for (const [accountId, api] of accounts.getActiveApis()) {
    const info = accounts.list().find(a => a.id === accountId);
    const result = await testSendImages(api, accountId, config, count);
    results.push({
      accountId,
      accountName: info?.name || info?.label || accountId,
      ...result,
    });
  }

  if (results.length === 0) {
    return c.json({ error: 'Không có account nào online. Login trước!' }, 400);
  }

  return c.json({ success: true, results });
});

// Kích hoạt listener cho account đã login (dùng khi login QR xong mà listener chưa chạy)
app.post('/api/activate', (c) => {
  let activated = 0;
  for (const [accountId, api] of accounts.getActiveApis()) {
    const info = accounts.list().find(a => a.id === accountId);
    if (info) {
      registerListeners(api, accountId, config);
      if (hasGroups(accountId, config)) {
        startWorker(api, accountId, info.name, config);
      }
      activated++;
    }
  }
  return c.json({ success: true, activated, message: `Đã kích hoạt ${activated} account(s)` });
});

// All-in-one: Save credentials + Activate workers + Test gửi hình
// POST /api/go?count=2
app.post('/api/go', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const count = (body as any)?.count || 2;
    const steps: string[] = [];

    // Step 1: Save credentials
    try {
      const stored = getAllStoredAccounts();
      fs.writeFileSync('./src/credentials.json', JSON.stringify(stored, null, 2));
      steps.push(`💾 Saved ${stored.length} credentials`);
    } catch (e: any) {
      steps.push(`⚠️ Save creds failed: ${e.message}`);
    }

    // Step 2: Activate workers + listeners
    let activated = 0;
    for (const [accountId, api] of accounts.getActiveApis()) {
      try {
        const info = accounts.list().find(a => a.id === accountId);
        if (info) {
          registerListeners(api, accountId, config);
          if (hasGroups(accountId, config)) {
            startWorker(api, accountId, info.name, config);
          }
          activated++;
        }
      } catch (e: any) {
        steps.push(`⚠️ Activate ${accountId}: ${e.message}`);
      }
    }
    steps.push(`🚀 Activated ${activated} workers`);

    // Step 3: Test send images
    const results: any[] = [];
    for (const [accountId, api] of accounts.getActiveApis()) {
      try {
        const info = accounts.list().find(a => a.id === accountId);
        const result = await testSendImages(api, accountId, config, count);
        results.push({
          accountId,
          accountName: info?.name || info?.label || accountId,
          ...result,
        });
      } catch (e: any) {
        results.push({
          accountId,
          accountName: accountId,
          sent: [],
          errors: [`Crash: ${e.message}`],
        });
      }
    }

    if (results.length === 0) {
      steps.push('❌ Không có account online');
    } else {
      const totalSent = results.reduce((s: number, r: any) => s + (r.sent?.length || 0), 0);
      steps.push(`📨 Sent ${totalSent} images total`);
    }

    return c.json({ success: true, steps, testResults: results });
  } catch (e: any) {
    return c.json({ success: false, error: e.message, stack: e.stack?.substring(0, 500) }, 500);
  }
});

// ═══════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════

function startAllWorkers(): void {
  for (const [accountId, api] of accounts.getActiveApis()) {
    const info = accounts.list().find(a => a.id === accountId);
    if (info) {
      // Đăng ký listener (auto reply, auto accept FR, auto pull)
      registerListeners(api, accountId, config);

      // Start worker (quét group, FR, gửi hình) - chỉ khi có source groups
      if (hasGroups(accountId, config)) {
        startWorker(api, accountId, info.name, config);
      }
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  🏠 Sale Bot BĐS - Cho Thuê');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // 1. Start API server
  Bun.serve({ port, fetch: app.fetch });
  console.log(`🌐 API: http://localhost:${port}`);
  console.log(`   GET  /api/accounts     - Danh sách accounts`);
  console.log(`   POST /api/accounts/add - Thêm account (QR)`);
  console.log(`   GET  /api/config       - Xem config`);
  console.log(`   PUT  /api/config       - Cập nhật config`);
  console.log(`   GET  /api/workers      - Status workers`);
  console.log('');

  // 2. Restore credentials từ bundled file + Login tất cả accounts
  initRestore();
  const accountCount = accounts.count();
  if (accountCount > 0) {
    console.log(`📱 Tìm thấy ${accountCount} tài khoản, đang login...`);
    const result = await accounts.loginAll();
    console.log(`✅ ${result.success} online, ❌ ${result.failed} failed`);
    if (result.errors.length > 0) {
      result.errors.forEach(e => console.log(`   ⚠️ ${e}`));
    }
    console.log('');
  } else {
    console.log('📱 Chưa có tài khoản nào.');
    console.log('👉 Chạy: bun src/add-account.ts');
    console.log('   Hoặc POST /api/accounts/add');
    console.log('');
  }

  // 3. Hiển thị config
  console.log(`📋 Config:`);
  console.log(`   Source groups (chung): ${config.sourceGroupLinks.length}`);
  console.log(`   Account groups: ${JSON.stringify(config.accountSourceGroups)}`);
  console.log(`   Target group: ${config.targetGroupLink || '(chưa set)'}`);
  console.log(`   FR/ngày: ${config.limits.friendRequestsPerDay}`);
  console.log(`   IMG/ngày: ${config.limits.imageSendsPerDay}`);
  console.log(`   Pull/ngày: ${config.limits.groupPullsPerDay}`);
  console.log(`   Giờ: ${config.activeHours.start}h - ${config.activeHours.end}h VN`);
  console.log('');

  // 4. Start workers
  startAllWorkers();

  // 5. Self-ping để không bị Render sleep (free tier sleep sau 15 phút)
  const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  setInterval(async () => {
    try {
      await fetch(`${APP_URL}/`);
      console.log('🏓 Self-ping OK');
    } catch {}
  }, 10 * 60 * 1000); // Mỗi 10 phút

  console.log(`🏓 Self-ping enabled (mỗi 10 phút) → ${APP_URL}`);
  console.log('👂 Bot đang chạy...');
}

main().catch(err => {
  console.error('❌ Lỗi khởi động:', err);
  process.exit(1);
});

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sale Bot BĐS</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;padding:16px}
.wrap{max-width:800px;margin:0 auto}
.hdr{text-align:center;padding:24px 0 16px}
.hdr h1{font-size:24px;color:#333}
.hdr p{color:#888;font-size:14px;margin-top:4px}
.card{background:#fff;border-radius:14px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.card h2{font-size:16px;color:#444;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.row{display:flex;gap:10px;margin-bottom:10px}
.row input,.row select{flex:1;padding:10px 12px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;outline:none}
.row input:focus{border-color:#667eea}
.btn{padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s}
.btn:active{transform:scale(.97)}
.btn-p{background:#667eea;color:#fff}.btn-p:hover{background:#5a6fd6}
.btn-d{background:#e74c3c;color:#fff;font-size:12px;padding:6px 12px}.btn-d:hover{background:#c0392b}
.btn-s{background:#27ae60;color:#fff;font-size:12px;padding:6px 12px}.btn-s:hover{background:#219a52}
.btn-w{background:#f39c12;color:#fff;font-size:12px;padding:6px 12px}
.btn-g{background:#95a5a6;color:#fff;font-size:12px;padding:6px 12px}
.tag{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600}
.tag-on{background:#d4edda;color:#155724}
.tag-off{background:#f8d7da;color:#721c24}
.tag-run{background:#cce5ff;color:#004085}
.acc{background:#f8f9fa;border-radius:10px;padding:14px;margin-bottom:10px}
.acc:last-child{margin-bottom:0}
.acc-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.acc-name{font-weight:600;font-size:15px;color:#333}
.acc-id{font-size:11px;color:#999;margin-top:2px}
.acc-stats{font-size:12px;color:#666;margin-top:6px}
.acc-stats span{margin-right:12px}
.grp-row{display:flex;gap:6px;margin-top:8px;align-items:center}
.grp-row input{flex:1;padding:8px 10px;border:1.5px solid #ddd;border-radius:6px;font-size:13px}
.grp-list{margin-top:6px}
.grp-item{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;color:#555}
.grp-item .x{color:#e74c3c;cursor:pointer;font-weight:bold;padding:0 4px}
.msg{padding:12px;border-radius:8px;margin-top:10px;font-size:13px;line-height:1.5}
.msg-ok{background:#d4edda;color:#155724}
.msg-err{background:#f8d7da;color:#721c24}
.msg-wait{background:#fff3cd;color:#856404}
.img-prev{margin-top:10px;text-align:center}
.img-prev img{max-width:100%;max-height:250px;border-radius:10px}
.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
</style></head><body>
<div class="wrap">
<div class="hdr"><h1>🏠 Sale Bot BĐS</h1><p>Quản lý bot Zalo tự động</p></div>

<div class="card">
<h2>➕ Thêm tài khoản Zalo</h2>
<div class="row">
<input id="newLabel" placeholder="Tên tài khoản (VD: Tú Nhi)" value="">
<button class="btn btn-p" onclick="addAcc()">Tạo QR</button>
</div>
<div id="addSt"></div>
</div>

<div class="card">
<h2>📱 Tài khoản & Bot</h2>
<div id="accList"><div class="msg msg-wait">Đang tải...</div></div>
</div>

<div class="card">
<h2>🖼️ Hình mời vào group</h2>
<div class="row">
<input type="file" id="imgFile" accept="image/*" style="padding:8px">
<button class="btn btn-p" onclick="uploadImg()">Upload</button>
</div>
<div id="imgSt"></div>
<div class="img-prev" id="imgPrev"></div>
</div>

<div class="card">
<h2>⚙️ Cài đặt chung</h2>
<div style="font-size:13px;color:#666" id="cfgInfo">Đang tải...</div>
</div>
</div>

<script>
const U=location.origin;
let CFG={};

async function api(path,opt){const r=await fetch(U+path,opt);return r.json()}

// ═══ LOAD ALL ═══
async function loadAll(){
  await loadConfig();
  await Promise.all([loadAccounts(),loadImg()]);
}

// ═══ ACCOUNTS ═══
async function loadAccounts(){
  const d=document.getElementById('accList');
  try{
    const [accR,wR,pR]=await Promise.all([api('/api/accounts'),api('/api/workers'),api('/api/progress')]);
    const accs=accR.accounts||[];
    const workers=wR.workers||[];
    const progress=pR||{};
    if(!accs.length){d.innerHTML='<div class="msg msg-wait">Chưa có tài khoản. Nhấn "Tạo QR" để thêm.</div>';return}
    
    d.innerHTML=accs.map(a=>{
      const w=workers.find(x=>x.accountId===a.id);
      const p=progress[a.id];
      const groups=CFG.accountSourceGroups?.[a.id]||[];
      const imgTotal=p?Object.values(p.imageSent||{}).reduce((s,arr)=>s+arr.length,0):0;
      const frTotal=p?Object.values(p.friendRequested||{}).reduce((s,arr)=>s+arr.length,0):0;
      
      return '<div class="acc">'+
        '<div class="acc-top">'+
          '<div><div class="acc-name">'+esc(a.label||a.name)+'</div>'+
          '<div class="acc-id">ID: '+a.id+'</div></div>'+
          '<div>'+
            '<span class="tag '+(a.online?'tag-on':'tag-off')+'">'+(a.online?'🟢 Online':'🔴 Offline')+'</span> '+
            (w?'<span class="tag tag-run">▶️ Running</span>':'')+
          '</div>'+
        '</div>'+
        (w?'<div class="acc-stats">'+
          '<span>📨 Hôm nay: FR '+w.friendRequestDaily+' | IMG '+w.imageSendDaily+' | Pull '+w.groupPullDaily+'</span><br>'+
          '<span>📊 Tổng: FR '+frTotal+' | IMG '+imgTotal+'</span>'+
        '</div>':'')+
        '<div class="grp-list" id="grp_'+a.id+'">'+
          groups.map((g,i)=>'<div class="grp-item"><span>📌 '+esc(g)+'</span><span class="x" onclick="rmGrp(\\''+a.id+'\\','+i+')">✕</span></div>').join('')+
          (groups.length===0?'<div style="font-size:12px;color:#999;padding:4px 0">Chưa có group. Thêm link group bên dưới.</div>':'')+
        '</div>'+
        '<div class="grp-row">'+
          '<input id="gi_'+a.id+'" placeholder="https://zalo.me/g/..." onkeydown="if(event.key===\\'Enter\\')addGrp(\\''+a.id+'\\')">'+
          '<button class="btn btn-s" onclick="addGrp(\\''+a.id+'\\')">+ Group</button>'+
        '</div>'+
        '<div class="actions">'+
          (!a.online?'<button class="btn btn-w" onclick="loginAcc(\\''+a.id+'\\')">🔑 Login</button>':'')+
          '<button class="btn btn-g" onclick="restartW(\\''+a.id+'\\')">🔄 Restart</button>'+
          '<button class="btn btn-d" onclick="delAcc(\\''+a.id+'\\')">🗑️ Xóa</button>'+
        '</div>'+
        '<div id="st_'+a.id+'"></div>'+
      '</div>';
    }).join('');
  }catch(e){d.innerHTML='<div class="msg msg-err">❌ '+e.message+'</div>'}
}

// ═══ ADD ACCOUNT ═══
async function addAcc(){
  const lb=document.getElementById('newLabel').value||'Account '+(Date.now()%1000);
  const d=document.getElementById('addSt');
  d.className='msg msg-wait';d.innerHTML='⏳ Đang tạo QR...';
  try{
    const j=await api('/api/accounts/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:lb})});
    if(j.qrUrl){
      d.className='msg msg-ok';
      d.innerHTML='✅ QR đã tạo! <a href="'+U+'/api/accounts/qr-page/'+j.qrId+'" target="_blank" style="color:#155724;font-weight:bold">👉 Mở trang quét QR</a><br><small>Quét xong nhấn nút bên dưới</small><br><button class="btn btn-s" style="margin-top:8px;width:auto" onclick="checkLogin(\\''+j.qrId+'\\')">✅ Đã quét xong</button>';
    }else throw new Error(j.error||'Lỗi');
  }catch(e){d.className='msg msg-err';d.innerHTML='❌ '+e.message}
}

async function checkLogin(qrId){
  const d=document.getElementById('addSt');
  d.className='msg msg-wait';d.innerHTML='⏳ Đang kiểm tra...';
  try{
    const j=await api('/api/accounts/login-status/'+qrId);
    if(j.status==='success'){
      d.className='msg msg-ok';d.innerHTML='✅ Đăng nhập thành công! '+esc(j.account?.name||'');
      loadAll();
    }else if(j.status==='waiting_scan'){
      d.className='msg msg-wait';d.innerHTML='⏳ Chưa quét xong. Thử lại sau vài giây.<br><button class="btn btn-s" style="margin-top:8px;width:auto" onclick="checkLogin(\\''+qrId+'\\')">🔄 Kiểm tra lại</button>';
    }else{
      d.className='msg msg-err';d.innerHTML='❌ '+(j.error||j.status);
    }
  }catch(e){d.className='msg msg-err';d.innerHTML='❌ '+e.message}
}

// ═══ GROUPS ═══
async function addGrp(accId){
  const inp=document.getElementById('gi_'+accId);
  const link=inp.value.trim();
  if(!link||!link.includes('zalo.me')){alert('Nhập link group Zalo hợp lệ');return}
  const groups=CFG.accountSourceGroups?.[accId]||[];
  if(groups.includes(link)){alert('Group đã tồn tại');return}
  groups.push(link);
  try{
    await api('/api/accounts/'+accId+'/groups',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({groups})});
    CFG.accountSourceGroups=CFG.accountSourceGroups||{};
    CFG.accountSourceGroups[accId]=groups;
    inp.value='';
    loadAccounts();
  }catch(e){alert('Lỗi: '+e.message)}
}

async function rmGrp(accId,idx){
  const groups=(CFG.accountSourceGroups?.[accId]||[]).slice();
  groups.splice(idx,1);
  try{
    await api('/api/accounts/'+accId+'/groups',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({groups})});
    CFG.accountSourceGroups[accId]=groups;
    loadAccounts();
  }catch(e){alert('Lỗi: '+e.message)}
}

// ═══ ACCOUNT ACTIONS ═══
async function loginAcc(id){
  const d=document.getElementById('st_'+id);
  d.className='msg msg-wait';d.innerHTML='⏳ Đang login...';
  try{
    const j=await api('/api/accounts/'+id+'/login',{method:'POST'});
    d.className=j.success?'msg msg-ok':'msg msg-err';
    d.innerHTML=j.success?'✅ Login OK':'❌ '+(j.error||'Lỗi');
    if(j.success)setTimeout(loadAccounts,1000);
  }catch(e){d.className='msg msg-err';d.innerHTML='❌ '+e.message}
}

async function restartW(id){
  const d=document.getElementById('st_'+id);
  d.className='msg msg-wait';d.innerHTML='⏳ Đang restart...';
  try{
    await api('/api/accounts/'+id+'/login',{method:'POST'});
    d.className='msg msg-ok';d.innerHTML='✅ Restarted';
    setTimeout(loadAccounts,1000);
  }catch(e){d.className='msg msg-err';d.innerHTML='❌ '+e.message}
}

async function delAcc(id){
  if(!confirm('Xóa tài khoản này?'))return;
  try{
    await api('/api/accounts/'+id,{method:'DELETE'});
    loadAccounts();
  }catch(e){alert('Lỗi: '+e.message)}
}

// ═══ IMAGE ═══
async function uploadImg(){
  const f=document.getElementById('imgFile').files[0];
  if(!f){alert('Chọn hình trước');return}
  const d=document.getElementById('imgSt');
  d.className='msg msg-wait';d.innerHTML='⏳ Đang upload...';
  try{
    const fd=new FormData();fd.append('image',f);
    const j=await api('/api/upload-image',{method:'POST',body:fd});
    if(j.success){d.className='msg msg-ok';d.innerHTML='✅ '+j.message;loadImg()}
    else throw new Error(j.error);
  }catch(e){d.className='msg msg-err';d.innerHTML='❌ '+e.message}
}

function loadImg(){
  document.getElementById('imgPrev').innerHTML='<img src="'+U+'/api/invite-image?t='+Date.now()+'" onerror="this.parentElement.innerHTML=\\'<span style=color:#999>Chưa có hình</span>\\'">';
}

// ═══ CONFIG ═══
async function loadConfig(){
  try{
    CFG=await api('/api/config');
    document.getElementById('cfgInfo').innerHTML=
      '🎯 Group đích: '+(CFG.targetGroupLink||'(chưa set)')+'<br>'+
      '📊 Giới hạn/ngày: FR '+CFG.limits?.friendRequestsPerDay+' | IMG '+CFG.limits?.imageSendsPerDay+' | Pull '+CFG.limits?.groupPullsPerDay+'<br>'+
      '🕐 Giờ hoạt động: '+CFG.activeHours?.start+'h - '+CFG.activeHours?.end+'h (VN)';
  }catch{}
}

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

loadAll();
setInterval(loadAccounts,30000);
</script></body></html>`;
}
