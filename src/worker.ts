/**
 * Worker - Chạy cho mỗi account Zalo
 * 
 * Flow: Quét TẤT CẢ groups → build danh sách member → gửi LẦN LƯỢT từ đầu đến cuối
 * Mỗi account có progress riêng, daily limit riêng.
 * 3 action (FR, IMG, PULL) chạy TUẦN TỰ trên cùng danh sách.
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { type BotConfig } from './config.js';
import { scanGroupMembers, type GroupMember } from './scanner.js';

// ═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════

interface AccountProgress {
  accountId: string;
  friendRequested: Record<string, string[]>; // groupLink -> [userId]
  friendRequestDaily: number;
  imageSent: Record<string, string[]>;
  imageSendDaily: number;
  groupPulled: Record<string, string[]>;
  groupPullDaily: number;
  lastDate: string;
}

interface WorkerState {
  running: boolean;
  accountId: string;
  accountName: string;
  progress: AccountProgress;
  timer: ReturnType<typeof setTimeout> | null;
  // Cache members per group (không bị overwrite)
  memberCache: Map<string, { members: GroupMember[]; groupName: string; scannedAt: number }>;
}

const workers = new Map<string, WorkerState>();

// Shared set — tránh 2 account gửi trùng
const sharedSent = {
  friendRequested: new Set<string>(),
  imageSent: new Set<string>(),
  groupPulled: new Set<string>(),
};

function buildSharedSets(): void {
  ensureProgressDir();
  const files = fs.readdirSync(PROGRESS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const data: AccountProgress = JSON.parse(fs.readFileSync(path.join(PROGRESS_DIR, f), 'utf-8'));
      for (const key of ['friendRequested', 'imageSent', 'groupPulled'] as const) {
        for (const ids of Object.values(data[key])) {
          for (const id of ids) sharedSent[key].add(id);
        }
      }
    } catch {}
  }
  console.log(`📊 Shared: FR=${sharedSent.friendRequested.size}, IMG=${sharedSent.imageSent.size}, PULL=${sharedSent.groupPulled.size}`);
}

// ═══════════════════════════════════════════════════
// PROGRESS
// ═══════════════════════════════════════════════════

const PROGRESS_DIR = path.resolve('./data/progress');
const BUNDLED_PROGRESS_DIR = path.resolve('./src/progress');

function ensureProgressDir(): void {
  if (!fs.existsSync(PROGRESS_DIR)) fs.mkdirSync(PROGRESS_DIR, { recursive: true });
}

function progressPath(accountId: string): string {
  return path.join(PROGRESS_DIR, `${accountId}.json`);
}

function restoreProgress(accountId: string): void {
  const targetPath = progressPath(accountId);
  const bundledPath = path.join(BUNDLED_PROGRESS_DIR, `${accountId}.json`);

  // Disk luôn được ưu tiên — chỉ dùng bundled khi disk chưa có
  if (!fs.existsSync(targetPath) && fs.existsSync(bundledPath)) {
    ensureProgressDir();
    fs.copyFileSync(bundledPath, targetPath);
    log(accountId, `📦 Progress: restored từ bundled (disk chưa có)`);
  }
}

function loadProgress(accountId: string): AccountProgress {
  ensureProgressDir();
  restoreProgress(accountId);
  try {
    const p = progressPath(accountId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return { accountId, friendRequested: {}, friendRequestDaily: 0, imageSent: {}, imageSendDaily: 0, groupPulled: {}, groupPullDaily: 0, lastDate: '' };
}

function saveProgress(progress: AccountProgress): void {
  ensureProgressDir();
  const json = JSON.stringify(progress, null, 2);
  fs.writeFileSync(progressPath(progress.accountId), json);
  try {
    if (!fs.existsSync(BUNDLED_PROGRESS_DIR)) fs.mkdirSync(BUNDLED_PROGRESS_DIR, { recursive: true });
    fs.writeFileSync(path.join(BUNDLED_PROGRESS_DIR, `${progress.accountId}.json`), json);
  } catch {}
}

function resetDailyIfNeeded(progress: AccountProgress): void {
  const today = getVNDate();
  if (progress.lastDate !== today) {
    progress.lastDate = today;
    progress.friendRequestDaily = 0;
    progress.imageSendDaily = 0;
    progress.groupPullDaily = 0;
  }
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function getVNDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function getVNHour(): number {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })).getHours();
}

function isActiveHours(config: BotConfig): boolean {
  const h = getVNHour();
  return h >= config.activeHours.start && h < config.activeHours.end;
}

function randomDelay(minMin: number, maxMin: number): number {
  const base = minMin + Math.random() * (maxMin - minMin);
  return base * 60 * 1000;
}

function log(accountId: string, msg: string): void {
  const time = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`[${time}] [${accountId.slice(-4)}] ${msg}`);
}

function getSourceGroups(accountId: string, config: BotConfig): string[] {
  return config.accountSourceGroups?.[accountId] || config.sourceGroupLinks;
}

// ═══════════════════════════════════════════════════
// SCAN — Cache members per group, refresh mỗi 2 giờ
// ═══════════════════════════════════════════════════

const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 giờ

async function getMembers(api: any, state: WorkerState, groupLink: string): Promise<GroupMember[]> {
  const cached = state.memberCache.get(groupLink);
  if (cached && Date.now() - cached.scannedAt < CACHE_TTL) {
    return cached.members;
  }
  const result = await scanGroupMembers(api, groupLink);
  state.memberCache.set(groupLink, { members: result.members, groupName: result.groupName, scannedAt: Date.now() });
  log(state.accountId, `👥 Scanned "${result.groupName}": ${result.members.length} members`);
  return result.members;
}

// ═══════════════════════════════════════════════════
// FIND NEXT — Tìm người chưa xử lý (dựa trên imageSent làm master)
// ═══════════════════════════════════════════════════

async function findNextPerson(
  api: any, state: WorkerState, config: BotConfig,
): Promise<{ member: GroupMember; groupLink: string } | null> {
  const progress = state.progress;
  const groups = getSourceGroups(state.accountId, config);

  // Build set TẤT CẢ userId đã gửi hình (cross-group) — 1 người chỉ nhận 1 hình
  const allSentIds = new Set<string>();
  for (const ids of Object.values(progress.imageSent)) {
    for (const id of ids) allSentIds.add(id);
  }

  for (const groupLink of groups) {
    let members: GroupMember[];
    try {
      members = await getMembers(api, state, groupLink);
    } catch (e: any) {
      log(state.accountId, `❌ Scan error ${groupLink}: ${e.message}`);
      continue;
    }

    for (const m of members) {
      if (!allSentIds.has(m.id)) {
        return { member: m, groupLink };
      }
    }

    // Group này hết người mới → tiếp tục group tiếp theo
    if (members.length > 0) {
      const doneInGroup = (progress.imageSent[groupLink] || []).length;
      log(state.accountId, `✅ Đã gửi hết ${doneInGroup}/${members.length} member trong group ${groupLink.split('/').pop()}`);
    }
  }

  // Tất cả groups đều hết → reset tất cả và bắt đầu vòng mới
  log(state.accountId, `🔄 Hết member trong TẤT CẢ ${groups.length} groups (đã gửi ${allSentIds.size} người) → reset vòng mới`);
  for (const groupLink of groups) {
    progress.imageSent[groupLink] = [];
    progress.friendRequested[groupLink] = [];
    progress.groupPulled[groupLink] = [];
  }
  // Clear member cache để quét lại member mới
  state.memberCache.clear();
  saveProgress(progress);

  // Thử lấy người đầu tiên từ group đầu tiên
  for (const groupLink of groups) {
    try {
      const members = await getMembers(api, state, groupLink);
      if (members.length > 0) return { member: members[0], groupLink };
    } catch {}
  }
  return null;
}

// ═══════════════════════════════════════════════════
// MAIN LOOP — Mỗi lần xử lý 1 NGƯỜI: FR → IMG → PULL
// Không bao giờ gửi trùng. Chuyển sang người mới mỗi lần.
// ═══════════════════════════════════════════════════

function markDone(progress: AccountProgress, trackKey: string, groupLink: string, userId: string): void {
  if (!(progress as any)[trackKey][groupLink]) (progress as any)[trackKey][groupLink] = [];
  (progress as any)[trackKey][groupLink].push(userId);
}

async function doWork(api: any, state: WorkerState, config: BotConfig): Promise<void> {
  if (!state.running) return;

  if (!isActiveHours(config)) {
    state.timer = setTimeout(() => doWork(api, state, config), 5 * 60 * 1000);
    return;
  }

  const progress = state.progress;
  resetDailyIfNeeded(progress);

  // Check daily limit (dùng imageSend làm counter chính)
  if (progress.imageSendDaily >= config.limits.imageSendsPerDay) {
    log(state.accountId, `⏸️ Đạt limit ${progress.imageSendDaily}/${config.limits.imageSendsPerDay} IMG hôm nay`);
    state.timer = setTimeout(() => doWork(api, state, config), 30 * 60 * 1000);
    return;
  }

  // Tìm 1 NGƯỜI mới chưa gửi
  const next = await findNextPerson(api, state, config);
  if (!next) {
    log(state.accountId, '⏸️ Hết member trong tất cả groups');
    state.timer = setTimeout(() => doWork(api, state, config), 30 * 60 * 1000);
    return;
  }

  const { member, groupLink } = next;
  const groupTag = groupLink.split('/').pop() || groupLink;
  log(state.accountId, `👤 [${groupTag}] Xử lý: ${member.name} (${member.id})`);

  // Gửi hình mời — action duy nhất
  const imagePath = path.resolve('./data', config.inviteImagePath);
  if (fs.existsSync(imagePath)) {
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const metadata = await sharp(imageBuffer).metadata();
      await api.sendMessage(
        { msg: '', attachments: [{ filename: 'invite.jpg', data: imageBuffer, metadata: { width: metadata.width || 800, height: metadata.height || 600, totalSize: imageBuffer.length } }] },
        member.id, 0,
      );
      progress.imageSendDaily++;
      log(state.accountId, `✅ IMG [${progress.imageSendDaily}/${config.limits.imageSendsPerDay}] [${groupTag}] → ${member.name}`);
    } catch (e: any) {
      log(state.accountId, `❌ IMG ${member.name}: ${e.message}`);
    }
  }

  // Đánh dấu đã xử lý (dù thành công hay lỗi — không gửi lại)
  markDone(progress, 'imageSent', groupLink, member.id);

  // Save progress
  saveProgress(progress);

  // Schedule next person
  if (state.running) {
    const delay = randomDelay(config.delays.imageSendMin, config.delays.imageSendMax);
    log(state.accountId, `⏰ Người tiếp theo in ${Math.round(delay / 60000)}min`);
    state.timer = setTimeout(() => doWork(api, state, config), delay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════

export function startWorker(api: any, accountId: string, accountName: string, config: BotConfig): void {
  if (workers.has(accountId)) {
    console.log(`⚠️ Worker ${accountId} đã chạy rồi`);
    return;
  }
  try { if (sharedSent.imageSent.size === 0) buildSharedSets(); } catch {}

  const state: WorkerState = {
    running: true, accountId, accountName,
    progress: loadProgress(accountId),
    timer: null,
    memberCache: new Map(),
  };
  workers.set(accountId, state);
  log(accountId, `🚀 Worker started cho ${accountName}`);

  if (isActiveHours(config)) {
    setTimeout(() => doWork(api, state, config), 2000);
  } else {
    log(accountId, `⏸️ Ngoài giờ (${config.activeHours.start}h-${config.activeHours.end}h VN), chờ...`);
    state.timer = setTimeout(() => doWork(api, state, config), 5 * 60 * 1000);
  }
}

export function stopWorker(accountId: string): void {
  const state = workers.get(accountId);
  if (!state) return;
  state.running = false;
  if (state.timer) clearTimeout(state.timer);
  workers.delete(accountId);
  log(accountId, '🛑 Worker stopped');
}

export function stopAllWorkers(): void {
  for (const [id] of workers) stopWorker(id);
}

export function getWorkersStatus(): Array<{
  accountId: string; accountName: string;
  friendRequestDaily: number; imageSendDaily: number; groupPullDaily: number;
  running: boolean;
}> {
  return Array.from(workers.values()).map(w => ({
    accountId: w.accountId, accountName: w.accountName,
    friendRequestDaily: w.progress.friendRequestDaily,
    imageSendDaily: w.progress.imageSendDaily,
    groupPullDaily: w.progress.groupPullDaily,
    running: w.running,
  }));
}

export async function testSendImages(
  api: any, accountId: string, config: BotConfig, count: number = 2,
): Promise<{ sent: string[]; errors: string[] }> {
  const sent: string[] = [];
  const errors: string[] = [];
  const imagePath = path.resolve('./data', config.inviteImagePath);
  if (!fs.existsSync(imagePath)) { errors.push('Không tìm thấy hình'); return { sent, errors }; }

  const imageBuffer = fs.readFileSync(imagePath);
  let metadata: { width?: number; height?: number };
  try { metadata = await sharp(imageBuffer).metadata(); } catch { metadata = { width: 800, height: 600 }; }

  const progress = loadProgress(accountId);
  for (const groupLink of getSourceGroups(accountId, config)) {
    if (sent.length >= count) break;
    let members: GroupMember[];
    try {
      const result = await scanGroupMembers(api, groupLink);
      members = result.members;
    } catch (e: any) { errors.push(`Scan error: ${e.message}`); continue; }

    const doneIds = new Set(progress.imageSent[groupLink] || []);
    for (const member of members) {
      if (sent.length >= count) break;
      if (doneIds.has(member.id) || sharedSent.imageSent.has(member.id)) continue;
      try {
        await api.sendMessage(
          { msg: '', attachments: [{ filename: 'invite.jpg', data: imageBuffer, metadata: { width: metadata.width || 800, height: metadata.height || 600, totalSize: imageBuffer.length } }] },
          member.id, 0,
        );
        if (!progress.imageSent[groupLink]) progress.imageSent[groupLink] = [];
        progress.imageSent[groupLink].push(member.id);
        progress.imageSendDaily++;
        saveProgress(progress);
        sent.push(`${member.name} (${member.id})`);
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      } catch (e: any) { errors.push(`${member.name}: ${e.message}`); }
    }
  }
  return { sent, errors };
}

export function exportAllProgress(): Record<string, AccountProgress> {
  ensureProgressDir();
  const result: Record<string, AccountProgress> = {};
  const files = fs.readdirSync(PROGRESS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try { const data = JSON.parse(fs.readFileSync(path.join(PROGRESS_DIR, f), 'utf-8')); result[data.accountId] = data; } catch {}
  }
  return result;
}
