/**
 * Account Manager - Quản lý nhiều tài khoản Zalo
 * Mỗi account lưu credentials trong data/accounts/<uid>.json
 */

import fs from 'node:fs';
import path from 'node:path';

// Import zca-js
const zcajs = await import('zca-js');
const { Zalo } = zcajs as any;

const ACCOUNTS_DIR = path.resolve('./data/accounts');
const BUNDLED_CREDS = path.resolve('./src/credentials.json'); // Credentials bundled trong repo
const apiInstances = new Map<string, any>();

// ═══════════════════════════════════════════════════
// ENV / BUNDLED CREDENTIALS - Persist qua deploy
// ═══════════════════════════════════════════════════

/**
 * Strip BOM và whitespace thừa từ JSON string (fix PowerShell encoding issues)
 */
function cleanJsonString(raw: string): string {
  // Strip BOM (EF BB BF)
  let cleaned = raw.replace(/^\uFEFF/, '');
  // Strip null bytes
  cleaned = cleaned.replace(/\0/g, '');
  return cleaned.trim();
}

/**
 * Restore accounts từ env var ZALO_CREDENTIALS hoặc bundled file
 */
function restoreCredentials(): void {
  ensureDir();

  // Ưu tiên 1: env var
  const envCreds = process.env.ZALO_CREDENTIALS;
  if (envCreds) {
    try {
      const json = Buffer.from(envCreds, 'base64').toString('utf-8');
      const stored: StoredAccount[] = JSON.parse(json);
      for (const data of stored) {
        if (!data?.info?.id) { console.log('⚠️ Skip account without id from env'); continue; }
        fs.writeFileSync(credPath(data.info.id), JSON.stringify(data, null, 2));
        console.log(`📦 Restored từ env: ${data.info.name} (${data.info.id})`);
      }
      return;
    } catch (e: any) {
      console.error('⚠️ Lỗi restore từ env:', e.message);
    }
  }

  // Ưu tiên 2: bundled file trong repo
  console.log(`📂 Checking bundled creds: ${BUNDLED_CREDS}, exists: ${fs.existsSync(BUNDLED_CREDS)}`);
  if (fs.existsSync(BUNDLED_CREDS)) {
    try {
      const raw = fs.readFileSync(BUNDLED_CREDS, 'utf-8');
      const cleaned = cleanJsonString(raw);
      const parsed = JSON.parse(cleaned);
      const stored: StoredAccount[] = Array.isArray(parsed) ? parsed : [parsed];
      console.log(`📦 Found ${stored.length} accounts in bundled file`);
      for (const data of stored) {
        // Validate: phải có info.id
        const id = data?.info?.id || data?.credentials?.uid;
        if (!id) {
          console.log(`⚠️ Skip account without id: ${JSON.stringify(data?.info || {}).substring(0, 100)}`);
          continue;
        }
        // Fix id nếu lấy từ credentials.uid
        if (!data.info.id && id) data.info.id = id;
        const targetPath = credPath(id);
        try {
          fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
          const exists = fs.existsSync(targetPath);
          console.log(`📦 Restored: ${data.info.label || data.info.name} (${id}) → ${targetPath} [exists=${exists}]`);
        } catch (writeErr: any) {
          console.error(`❌ Failed to write ${targetPath}: ${writeErr.message}`);
        }
      }
    } catch (e: any) {
      console.error('⚠️ Lỗi restore từ bundled:', e.message);
    }
  }

  // Log what's in accounts dir
  const files = fs.readdirSync(ACCOUNTS_DIR);
  console.log(`📂 Accounts dir has ${files.length} files: ${files.join(', ')}`);
}

/**
 * Export tất cả credentials thành base64 string
 */
function exportCredentials(): string {
  ensureDir();
  const files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('qr_'));
  const stored: StoredAccount[] = [];
  for (const f of files) {
    try {
      const data: StoredAccount = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf-8'));
      stored.push(data);
    } catch {}
  }
  return Buffer.from(JSON.stringify(stored)).toString('base64');
}

/**
 * Lấy tất cả stored accounts (để lưu vào repo)
 */
function getAllStoredAccounts(): StoredAccount[] {
  ensureDir();
  const files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('qr_'));
  const stored: StoredAccount[] = [];
  for (const f of files) {
    try {
      stored.push(JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf-8')));
    } catch {}
  }
  return stored;
}

// Auto restore khi khởi động - gọi từ main() thay vì top-level
export function initRestore(): void {
  restoreCredentials();
}

export { exportCredentials as exportAllCredentials, getAllStoredAccounts };

export interface AccountInfo {
  id: string;
  name: string;
  label: string;
  createdAt: string;
  lastLoginAt: string;
  status: 'active' | 'expired' | 'error';
}

interface StoredAccount {
  info: AccountInfo;
  credentials: any;
}

function ensureDir(): void {
  if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}

function credPath(id: string): string {
  return path.join(ACCOUNTS_DIR, `${id}.json`);
}

function save(data: StoredAccount): void {
  ensureDir();
  fs.writeFileSync(credPath(data.info.id), JSON.stringify(data, null, 2));
}

function load(id: string): StoredAccount | null {
  try {
    const p = credPath(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export const accounts = {
  /** Danh sách tất cả accounts */
  list(): AccountInfo[] {
    ensureDir();
    const files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('qr_'));
    return files.map(f => {
      try {
        const data: StoredAccount = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf-8'));
        return data.info;
      } catch { return null; }
    }).filter(Boolean) as AccountInfo[];
  },

  /** Thêm account bằng QR code */
  async addByQR(label?: string, customQrPath?: string): Promise<{ success: boolean; account?: AccountInfo; qrPath?: string; error?: string }> {
    const qrPath = customQrPath || path.resolve(`./data/accounts/qr_${Date.now()}.png`);
    ensureDir();

    try {
      console.log(`📱 Tạo mã QR tại: ${qrPath}`);
      console.log('👉 Mở Zalo trên điện thoại → Quét mã QR này');
      console.log('');

      const zaloInstance = new Zalo({ selfListen: false, logging: false });
      const api = await zaloInstance.loginQR({ qrPath });

      const ctx = api.getContext();
      const uid = ctx.uid;
      const userName = ctx?.loginInfo?.name || 'Unknown';

      const info: AccountInfo = {
        id: uid,
        name: userName,
        label: label || `Account ${uid.slice(-4)}`,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        status: 'active',
      };

      save({ info, credentials: ctx });
      apiInstances.set(uid, api);

      // Cleanup QR
      if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

      console.log(`✅ Đã thêm: ${userName} (${uid})`);
      return { success: true, account: info };
    } catch (e: any) {
      return { success: false, error: e.message, qrPath };
    }
  },

  /** Login 1 account bằng credentials đã lưu */
  async login(accountId: string): Promise<{ success: boolean; api?: any; error?: string }> {
    if (apiInstances.has(accountId)) {
      return { success: true, api: apiInstances.get(accountId) };
    }

    const data = load(accountId);
    if (!data) {
      // Debug: check if file exists
      const p = credPath(accountId);
      const exists = fs.existsSync(p);
      const allFiles = fs.readdirSync(ACCOUNTS_DIR);
      console.log(`⚠️ Login: account ${accountId} not found. File exists=${exists}, dir files=[${allFiles.join(',')}]`);
      return { success: false, error: `Account not found (file exists=${exists})` };
    }

    try {
      console.log(`🔑 Logging in: ${data.info.label} (${accountId})...`);
      const zaloInstance = new Zalo({ selfListen: false, logging: false });
      const api = await zaloInstance.login(data.credentials);

      data.info.lastLoginAt = new Date().toISOString();
      data.info.status = 'active';
      save({ info: data.info, credentials: api.getContext() });
      apiInstances.set(accountId, api);

      console.log(`✅ Logged in: ${data.info.name} (${accountId})`);
      return { success: true, api };
    } catch (e: any) {
      data.info.status = 'expired';
      save(data);
      return { success: false, error: `Login failed: ${e.message}` };
    }
  },

  /** Login tất cả accounts */
  async loginAll(): Promise<{ success: number; failed: number; errors: string[] }> {
    const all = this.list();
    console.log(`📱 loginAll: found ${all.length} accounts: ${all.map(a => `${a.label}(${a.id})`).join(', ')}`);
    let success = 0, failed = 0;
    const errors: string[] = [];

    for (const acc of all) {
      const result = await this.login(acc.id);
      if (result.success) success++;
      else {
        failed++;
        errors.push(`${acc.name}: ${result.error}`);
      }
    }
    return { success, failed, errors };
  },

  /** Lấy API instance */
  getApi(accountId: string): any | null {
    return apiInstances.get(accountId) || null;
  },

  /** Lấy tất cả active APIs */
  getActiveApis(): Map<string, any> {
    return apiInstances;
  },

  /** Xóa account */
  remove(accountId: string): boolean {
    const p = credPath(accountId);
    if (!fs.existsSync(p)) return false;
    apiInstances.delete(accountId);
    fs.unlinkSync(p);
    console.log(`🗑️ Đã xóa account: ${accountId}`);
    return true;
  },

  /** Số lượng accounts */
  count(): number {
    ensureDir();
    return fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('qr_')).length;
  },

  /** Account có online không */
  isOnline(id: string): boolean {
    return apiInstances.has(id);
  },
};
