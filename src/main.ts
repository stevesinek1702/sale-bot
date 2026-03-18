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

/** Check account có source groups không (riêng hoặc chung) */
function hasGroups(accountId: string, config: BotConfig): boolean {
  return (config.accountSourceGroups?.[accountId]?.length || config.sourceGroupLinks.length) > 0;
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
<title>Sale Bot BĐS - Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.c{background:#fff;border-radius:20px;padding:40px;max-width:600px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)}
h1{color:#333;margin-bottom:8px;font-size:28px}
.sub{color:#666;margin-bottom:24px}
.sec{margin-bottom:28px}
.sec h2{font-size:17px;color:#555;margin-bottom:12px}
btn,button{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;width:100%;transition:transform .2s}
button:hover{transform:translateY(-2px)}
button:disabled{background:#ccc;cursor:not-allowed;transform:none}
.st{padding:14px;border-radius:10px;margin-top:12px;font-size:14px;line-height:1.6}
.st.l{background:#fff3cd;color:#856404}
.st.s{background:#d4edda;color:#155724}
.st.e{background:#f8d7da;color:#721c24}
.al{background:#f8f9fa;padding:14px;border-radius:10px;margin-top:12px}
.ai{background:#fff;padding:12px;border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.ai:last-child{margin-bottom:0}
.an{font-weight:600;color:#333}
.as{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
.as.on{background:#d4edda;color:#155724}
.as.off{background:#f8d7da;color:#721c24}
input{width:100%;padding:12px;border:2px solid #e0e0e0;border-radius:8px;font-size:14px;margin-bottom:12px}
input:focus{outline:none;border-color:#667eea}
a{color:#667eea;font-weight:600}
</style></head><body>
<div class="c">
<h1>🏠 Sale Bot BĐS</h1>
<p class="sub">Dashboard quản lý tài khoản Zalo</p>
<div class="sec">
<h2>➕ Thêm tài khoản Zalo</h2>
<input type="text" id="lb" placeholder="Tên tài khoản" value="Account 1">
<button onclick="addAcc()">Tạo mã QR đăng nhập</button>
<div id="as"></div>
</div>
<div class="sec">
<h2>📱 Danh sách tài khoản</h2>
<button onclick="loadAcc()">Tải danh sách</button>
<div id="al"></div>
</div>
<div class="sec">
<h2>🖼️ Hình mời vào group</h2>
<input type="file" id="imgFile" accept="image/*" style="margin-bottom:8px">
<button onclick="uploadImg()">Upload hình</button>
<div id="imgSt"></div>
<div id="imgPrev" style="margin-top:12px;text-align:center"></div>
</div>
<div class="sec">
<h2>⚙️ Workers</h2>
<button onclick="loadW()">Xem trạng thái</button>
<button onclick="goTest()" style="margin-top:8px;background:linear-gradient(135deg,#f093fb,#f5576c)">🚀 Save + Activate + Test Gửi Hình</button>
<div id="ws"></div>
<div id="goSt"></div>
</div>
<div class="sec">
<h2>🔑 Lưu đăng nhập (Persist)</h2>
<button onclick="getCreds()">Lấy Credentials</button>
<div id="credSt"></div>
<textarea id="credVal" style="width:100%;height:80px;margin-top:8px;font-size:12px;border:2px solid #e0e0e0;border-radius:8px;padding:8px;display:none" readonly></textarea>
<p style="font-size:12px;color:#999;margin-top:4px">Copy giá trị trên → Render → Environment → ZALO_CREDENTIALS</p>
</div>
</div>
<script>
const U=location.origin;
async function addAcc(){
  const lb=document.getElementById('lb').value||'Account 1';
  const d=document.getElementById('as');
  d.className='st l';d.innerHTML='⏳ Đang tạo QR (chờ ~5s)...';
  try{
    const r=await fetch(U+'/api/accounts/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:lb})});
    const j=await r.json();
    if(j.qrUrl){
      d.className='st s';
      d.innerHTML='✅ QR đã tạo!<br><a href="'+U+'/api/accounts/qr-page/'+j.qrId+'" target="_blank">👉 Mở trang quét QR</a><br><small>Quét xong nhấn "Tải danh sách" để kiểm tra</small>';
    }else throw new Error(j.error||'Lỗi');
  }catch(e){d.className='st e';d.innerHTML='❌ '+e.message}
}
async function loadAcc(){
  const d=document.getElementById('al');
  d.innerHTML='<div class="st l">⏳ Đang tải...</div>';
  try{
    const r=await fetch(U+'/api/accounts');const j=await r.json();
    if(j.accounts?.length>0){
      d.innerHTML='<div class="al">'+j.accounts.map(a=>'<div class="ai"><div><div class="an">'+a.name+'</div><div style="font-size:12px;color:#666">'+a.label+' • '+a.id.slice(-8)+'</div></div><span class="as '+(a.online?'on':'off')+'">'+(a.online?'🟢 Online':'🔴 Offline')+'</span></div>').join('')+'</div>';
    }else d.innerHTML='<div class="st">Chưa có tài khoản</div>';
  }catch(e){d.innerHTML='<div class="st e">❌ '+e.message+'</div>'}
}
async function loadW(){
  const d=document.getElementById('ws');
  d.innerHTML='<div class="st l">⏳ Đang tải...</div>';
  try{
    const r=await fetch(U+'/api/workers');const j=await r.json();
    if(j.workers?.length>0){
      d.innerHTML='<div class="al">'+j.workers.map(w=>'<div class="ai"><div><div class="an">'+w.accountName+'</div><div style="font-size:12px;color:#666">FR:'+w.friendRequestDaily+' IMG:'+w.imageSendDaily+' Pull:'+w.groupPullDaily+'</div></div><span class="as '+(w.running?'on':'off')+'">'+(w.running?'▶️ Running':'⏸️ Stop')+'</span></div>').join('')+'</div>';
    }else d.innerHTML='<div class="st">Chưa có worker</div>';
  }catch(e){d.innerHTML='<div class="st e">❌ '+e.message+'</div>'}
}
async function uploadImg(){
  const f=document.getElementById('imgFile').files[0];
  if(!f){alert('Chọn hình trước');return}
  const d=document.getElementById('imgSt');
  d.className='st l';d.innerHTML='⏳ Đang upload...';
  try{
    const fd=new FormData();fd.append('image',f);
    const r=await fetch(U+'/api/upload-image',{method:'POST',body:fd});
    const j=await r.json();
    if(j.success){
      d.className='st s';d.innerHTML='✅ '+j.message+' ('+Math.round(j.size/1024)+'KB)';
      loadInviteImg();
    }else throw new Error(j.error);
  }catch(e){d.className='st e';d.innerHTML='❌ '+e.message}
}
function loadInviteImg(){
  const d=document.getElementById('imgPrev');
  d.innerHTML='<img src="'+U+'/api/invite-image?t='+Date.now()+'" style="max-width:100%;max-height:300px;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.15)" onerror="this.parentElement.innerHTML=\\'<span style=color:#999>Chưa có hình</span>\\'">';
}
loadInviteImg();
async function goTest(){
  const d=document.getElementById('goSt');
  d.className='st l';d.innerHTML='⏳ Đang save + activate + test gửi hình (chờ 30-60s)...';
  try{
    const r=await fetch(U+'/api/go',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:2})});
    const txt=await r.text();
    let j;
    try{j=JSON.parse(txt)}catch{d.className='st e';d.innerHTML='❌ Server error: '+txt.substring(0,200);return}
    if(j.success){
      let html='<div class="st s">✅ Hoàn tất!<br>';
      (j.steps||[]).forEach(s=>html+=s+'<br>');
      if(j.testResults?.length>0){
        j.testResults.forEach(r=>{
          html+='<br><b>'+(r.accountName||r.accountId)+':</b><br>';
          if(r.sent?.length>0)r.sent.forEach(s=>html+='  ✅ '+s+'<br>');
          if(r.errors?.length>0)r.errors.forEach(e=>html+='  ❌ '+e+'<br>');
          if(!r.sent?.length&&!r.errors?.length)html+='  (no results)<br>';
        });
      }
      html+='</div>';d.innerHTML=html;
    }else{d.className='st e';d.innerHTML='❌ '+(j.error||JSON.stringify(j))}
  }catch(e){d.className='st e';d.innerHTML='❌ '+e.message}
}
async function getCreds(){
  const d=document.getElementById('credSt');
  const t=document.getElementById('credVal');
  d.className='st l';d.innerHTML='⏳ Đang lấy...';
  try{
    const r=await fetch(U+'/api/credentials');const j=await r.json();
    if(j.count>0){
      d.className='st s';d.innerHTML='✅ '+j.count+' account(s). Copy giá trị bên dưới:';
      t.style.display='block';t.value=j.credentials;t.select();
    }else{d.className='st e';d.innerHTML='❌ Chưa có account nào. Login trước!'}
  }catch(e){d.className='st e';d.innerHTML='❌ '+e.message}
}
</script></body></html>`;
}
