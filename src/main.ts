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
import { accounts } from './account.js';
import { loadConfig, saveConfig, type BotConfig } from './config.js';
import { startWorker, stopWorker, stopAllWorkers, getWorkersStatus } from './worker.js';

let config = loadConfig();

// ═══════════════════════════════════════════════════
// API SERVER
// ═══════════════════════════════════════════════════

const app = new Hono();
const port = Number(process.env.PORT) || 3000;
const startTime = Date.now();

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

// Xóa account
app.delete('/api/accounts/:id', (c) => {
  const id = c.req.param('id');
  stopWorker(id);
  const removed = accounts.remove(id);
  return c.json({ success: removed });
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

app.post('/api/workers/restart', (c) => {
  stopAllWorkers();
  startAllWorkers();
  return c.json({ success: true, workers: getWorkersStatus() });
});

// ═══════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════

function startAllWorkers(): void {
  if (config.sourceGroupLinks.length === 0) {
    console.log('⚠️ Chưa có sourceGroupLinks trong config. Cập nhật data/config.json');
    return;
  }

  for (const [accountId, api] of accounts.getActiveApis()) {
    const info = accounts.list().find(a => a.id === accountId);
    if (info) {
      startWorker(api, accountId, info.name, config);
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

  // 2. Login tất cả accounts đã lưu
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
  console.log(`   Source groups: ${config.sourceGroupLinks.length}`);
  console.log(`   Target group: ${config.targetGroupLink || '(chưa set)'}`);
  console.log(`   FR/ngày: ${config.limits.friendRequestsPerDay}`);
  console.log(`   IMG/ngày: ${config.limits.imageSendsPerDay}`);
  console.log(`   Pull/ngày: ${config.limits.groupPullsPerDay}`);
  console.log(`   Giờ: ${config.activeHours.start}h - ${config.activeHours.end}h VN`);
  console.log('');

  // 4. Start workers
  startAllWorkers();

  console.log('👂 Bot đang chạy...');
}

main().catch(err => {
  console.error('❌ Lỗi khởi động:', err);
  process.exit(1);
});
