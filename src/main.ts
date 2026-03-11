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
import { accounts, exportAllCredentials, getAllStoredAccounts } from './account.js';
import { loadConfig, saveConfig, type BotConfig } from './config.js';
import { startWorker, stopWorker, stopAllWorkers, getWorkersStatus } from './worker.js';
import { registerListeners } from './listener.js';

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

  // Khi login xong → đăng ký listener + start worker + save credentials
  loginPromise.then((result) => {
    if (result.success && result.account) {
      const api = accounts.getApi(result.account.id);
      if (api) {
        console.log(`🎉 Login thành công: ${result.account.name}, đang đăng ký listener...`);
        registerListeners(api, result.account.id, config);
        if (config.sourceGroupLinks.length > 0) {
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
    }
  }).catch(() => {});

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

app.post('/api/workers/restart', (c) => {
  stopAllWorkers();
  startAllWorkers();
  return c.json({ success: true, workers: getWorkersStatus() });
});

// Kích hoạt listener cho account đã login (dùng khi login QR xong mà listener chưa chạy)
app.post('/api/activate', (c) => {
  let activated = 0;
  for (const [accountId, api] of accounts.getActiveApis()) {
    const info = accounts.list().find(a => a.id === accountId);
    if (info) {
      registerListeners(api, accountId, config);
      if (config.sourceGroupLinks.length > 0) {
        startWorker(api, accountId, info.name, config);
      }
      activated++;
    }
  }
  return c.json({ success: true, activated, message: `Đã kích hoạt ${activated} account(s)` });
});

// ═══════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════

function startAllWorkers(): void {
  if (config.sourceGroupLinks.length === 0) {
    console.log('⚠️ Chưa có sourceGroupLinks trong config. Cập nhật data/config.json');
  }

  for (const [accountId, api] of accounts.getActiveApis()) {
    const info = accounts.list().find(a => a.id === accountId);
    if (info) {
      // Đăng ký listener (auto reply, auto accept FR, auto pull)
      registerListeners(api, accountId, config);

      // Start worker (quét group, FR, gửi hình) - chỉ khi có source groups
      if (config.sourceGroupLinks.length > 0) {
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
<div id="ws"></div>
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
