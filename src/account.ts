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
const BUNDLED_CREDS = path.resolve('./src/credentials.json');
const BUNDLED_ACCOUNTS_DIR = path.resolve('./src/accounts');
const apiInstances = new Map<string, any>();

function cleanJsonString(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\0/g, '').trim();
}

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
  try {
    if (!fs.existsSync(BUNDLED_ACCOUNTS_DIR)) fs.mkdirSync(BUNDLED_ACCOUNTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(BUNDLED_ACCOUNTS_DIR, `${data.info.id}.json`), JSON.stringify(data, null, 2));
  } catch {}
}

function load(id: string): StoredAccount | null {
  try {
    const p = credPath(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return null; }
}

/**
 * initRestore - Khôi phục credentials khi khởi động
 * 
 * Logic đơn giản:
 * 1. Đọc credentials.json (bundled trong Docker image, LUÔN có credentials mới nhất từ repo)
 * 2. GHI ĐÈ vào data/accounts/ (persistent disk) — vì credentials.json từ repo luôn đúng
 * 3. Nếu disk có account mà bundled không có → giữ nguyên (account thêm qua QR trên server)
 */
export function initRestore(): void {
  ensureDir();
  console.log('🔄 initRestore() starting...');

  const restoredIds = new Set<string>();

  // Step 1: credentials.json → GHI ĐÈ vào disk (luôn ưu tiên)
  if (fs.existsSync(BUNDLED_CREDS)) {
    try {
      const raw = fs.readFileSync(BUNDLED_CREDS, 'utf-8');
      const parsed = JSON.parse(cleanJsonString(raw));
      const stored: StoredAccount[] = Array.isArray(parsed) ? parsed : [parsed];
      console.log(`📦 credentials.json: ${stored.length} accounts`);
      for (const data of stored) {
        const id = data?.info?.id || data?.credentials?.uid;
        if (!id) continue;
        if (!data.info.id) data.info.id = id;
        fs.writeFileSync(credPath(id), JSON.stringify(data, null, 2));
        restoredIds.add(id);
        console.log(`📦 Restored: ${data.info.label} (${id}) [${data.info.status}]`);
      }
    } catch (e: any) {
      console.error('⚠️ Lỗi đọc credentials.json:', e.message);
    }
  }

  // Step 2: src/accounts/ → chỉ copy nếu chưa restored từ credentials.json
  if (fs.existsSync(BUNDLED_ACCOUNTS_DIR)) {
    const files = fs.readdirSync(BUNDLED_ACCOUNTS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const id = f.replace('.json', '');
      if (restoredIds.has(id)) continue;
      const dst = credPath(id);
      if (!fs.existsSync(dst)) {
        try {
          fs.copyFileSync(path.join(BUNDLED_ACCOUNTS_DIR, f), dst);
          console.log(`📦 Copied from src/accounts: ${f}`);
        } catch {}
      }
    }
  }

  // Log final state
  const finalFiles = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('qr_'));
  for (const f of finalFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf-8'));
      console.log(`📋 ${f}: ${data?.info?.label} [${data?.info?.status}] lastLogin=${data?.info?.lastLoginAt}`);
    } catch {}
  }
}

function exportCredentials(): string {
  ensureDir();
  const files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('qr_'));
  const stored: StoredAccount[] = [];
  for (const f of files) {
    try { stored.push(JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf-8'))); } catch {}
  }
  return Buffer.from(JSON.stringify(stored)).toString('base64');
}

function getAllStoredAccounts(): StoredAccount[] {
  ensureDir();
  const files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('qr_'));
  const stored: StoredAccount[] = [];
  for (const f of files) {
    try { stored.push(JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf-8'))); } catch {}
  }
  return stored;
}

export { exportCredentials as exportAllCredentials, getAllStoredAccounts };

export const accounts = {
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

  async addByQR(label?: string, customQrPath?: string): Promise<{ success: boolean; account?: AccountInfo; qrPath?: string; error?: string }> {
    const qrPath = customQrPath || path.resolve(`./data/accounts/qr_${Date.now()}.png`);
    ensureDir();
    try {
      const zaloInstance = new Zalo({ selfListen: false, logging: false });
      const api = await zaloInstance.loginQR({ qrPath });
      const ctx = api.getContext();
      const uid = ctx.uid;
      const userName = ctx?.loginInfo?.name || 'Unknown';
      const info: AccountInfo = {
        id: uid, name: userName, label: label || `Account ${uid.slice(-4)}`,
        createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString(), status: 'active',
      };
      save({ info, credentials: ctx });
      apiInstances.set(uid, api);
      if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
      console.log(`✅ Đã thêm: ${userName} (${uid})`);
      return { success: true, account: info };
    } catch (e: any) {
      return { success: false, error: e.message, qrPath };
    }
  },

  async login(accountId: string): Promise<{ success: boolean; api?: any; error?: string }> {
    if (apiInstances.has(accountId)) return { success: true, api: apiInstances.get(accountId) };
    const data = load(accountId);
    if (!data) return { success: false, error: 'Account not found' };
    try {
      console.log(`🔑 Logging in: ${data.info.label} (${accountId})...`);
      const zaloInstance = new Zalo({ selfListen: false, logging: false });
      const api = await zaloInstance.login(data.credentials);
      data.info.lastLoginAt = new Date().toISOString();
      data.info.status = 'active';
      save({ info: data.info, credentials: api.getContext() });
      apiInstances.set(accountId, api);
      console.log(`✅ Logged in: ${data.info.label} (${accountId})`);
      return { success: true, api };
    } catch (e: any) {
      data.info.status = 'expired';
      save(data);
      return { success: false, error: `Login failed: ${e.message}` };
    }
  },

  async loginAll(): Promise<{ success: number; failed: number; errors: string[] }> {
    const all = this.list();
    console.log(`📱 loginAll: ${all.length} accounts: ${all.map(a => `${a.label}(${a.id})`).join(', ')}`);
    let success = 0, failed = 0;
    const errors: string[] = [];
    for (const acc of all) {
      const result = await this.login(acc.id);
      if (result.success) success++;
      else { failed++; errors.push(`${acc.label}: ${result.error}`); }
    }
    return { success, failed, errors };
  },

  getApi(accountId: string): any | null { return apiInstances.get(accountId) || null; },
  getActiveApis(): Map<string, any> { return apiInstances; },

  remove(accountId: string): boolean {
    const p = credPath(accountId);
    if (!fs.existsSync(p)) return false;
    apiInstances.delete(accountId);
    fs.unlinkSync(p);
    return true;
  },

  count(): number {
    ensureDir();
    return fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('qr_')).length;
  },

  isOnline(id: string): boolean { return apiInstances.has(id); },
};
