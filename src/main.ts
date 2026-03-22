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
import { startWorker, stopWorker, stopAllWorkers, getWorkersStatus, exportAllProgress, testSendImages, getAccountStats } from './worker.js';
import { registerListeners } from './listener.js';
import { pushFilesToGitHub } from './git-sync.js';

/** Check account có source groups không (riêng hoặc chung) */
function hasGroups(accountId: string, config: BotConfig): boolean {
  return (config.accountSourceGroups?.[accountId]?.length || config.sourceGroupLinks.length) > 0;
}

/** Push config + credentials + progress lên GitHub để persist qua deploy */
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

    // Progress — persist qua deploy để không gửi lại người đã gửi
    const progressDir = './data/progress';
    if (fs.existsSync(progressDir)) {
      for (const f of fs.readdirSync(progressDir).filter(f => f.endsWith('.json'))) {
        files.push({ path: `src/progress/${f}`, content: fs.readFileSync(`${progressDir}/${f}`, 'utf-8') });
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

// Dashboard HTML — served from separate file to avoid encoding corruption
app.get('/dashboard', (c) => {
  const html = fs.readFileSync('./src/dashboard.html', 'utf-8');
  return c.html(html);
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

  // Restart workers với config mới
  stopAllWorkers();
  startAllWorkers();

  return c.json({ success: true, config });
});

// ─── Workers ───

app.get('/api/workers', (c) => c.json({ workers: getWorkersStatus() }));

// Stats per account — daily progress, total all-time, groups exhausted
app.get('/api/stats', (c) => {
  const stats: Record<string, any> = {};
  for (const acc of accounts.list()) {
    stats[acc.id] = getAccountStats(acc.id, config);
  }
  return c.json(stats);
});

// Manual sync to GitHub
app.post('/api/sync-github', async (c) => {
  try {
    await syncToGitHub('manual sync from dashboard');
    return c.json({ success: true, message: 'Đã lưu lên GitHub thành công' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

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

  // 6. Auto-save progress to GitHub every 30 min — persist qua deploy
  setInterval(async () => {
    try {
      console.log('💾 Auto-save: syncing progress to GitHub...');
      await syncToGitHub('auto-save progress');
    } catch {}
  }, 30 * 60 * 1000);
  console.log('💾 Auto-save enabled (every 30 min)');

  console.log('👂 Bot đang chạy...');
}

main().catch(err => {
  console.error('❌ Lỗi khởi động:', err);
  process.exit(1);
});

