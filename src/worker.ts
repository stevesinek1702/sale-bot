/**
 * Worker - Chạy cho mỗi account Zalo
 * 
 * Flow cho mỗi account:
 * 1. Quét member từ source groups
 * 2. Gửi lời mời kết bạn
 * 3. Gửi hình mời vào group
 * 4. Kéo member vào group đích
 * 
 * Mỗi account có progress riêng, daily limit riêng.
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
  // Friend requests
  friendRequested: Record<string, string[]>; // groupLink -> [userId]
  friendRequestDaily: number;
  // Image sends
  imageSent: Record<string, string[]>;
  imageSendDaily: number;
  // Group pulls
  groupPulled: Record<string, string[]>;
  groupPullDaily: number;
  // Tracking
  lastDate: string;
  currentGroupIndex: number;
  completedGroups: string[];
}

interface WorkerState {
  running: boolean;
  accountId: string;
  accountName: string;
  progress: AccountProgress;
  timers: {
    friendRequest: ReturnType<typeof setTimeout> | null;
    imageSend: ReturnType<typeof setTimeout> | null;
    groupPull: ReturnType<typeof setTimeout> | null;
  };
  // Cache
  cachedGroupLink: string;
  cachedMembers: GroupMember[];
  cachedGroupName: string;
}

// Active workers
const workers = new Map<string, WorkerState>();

// ═══════════════════════════════════════════════════
// PROGRESS TRACKING
// ═══════════════════════════════════════════════════

const PROGRESS_DIR = path.resolve('./data/progress');

function ensureProgressDir(): void {
  if (!fs.existsSync(PROGRESS_DIR)) fs.mkdirSync(PROGRESS_DIR, { recursive: true });
}

function progressPath(accountId: string): string {
  return path.join(PROGRESS_DIR, `${accountId}.json`);
}

function loadProgress(accountId: string): AccountProgress {
  ensureProgressDir();
  try {
    const p = progressPath(accountId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return {
    accountId,
    friendRequested: {},
    friendRequestDaily: 0,
    imageSent: {},
    imageSendDaily: 0,
    groupPulled: {},
    groupPullDaily: 0,
    lastDate: '',
    currentGroupIndex: 0,
    completedGroups: [],
  };
}

function saveProgress(progress: AccountProgress): void {
  ensureProgressDir();
  fs.writeFileSync(progressPath(progress.accountId), JSON.stringify(progress, null, 2));
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

function randomDelay(minMinutes: number, maxMinutes: number): number {
  return (minMinutes + Math.random() * (maxMinutes - minMinutes)) * 60 * 1000;
}

function log(accountId: string, msg: string): void {
  const time = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`[${time}] [${accountId.slice(-4)}] ${msg}`);
}


// ═══════════════════════════════════════════════════
// CORE ACTIONS
// ═══════════════════════════════════════════════════

/**
 * Tìm member chưa xử lý từ danh sách group
 */
async function findNextMember(
  api: any,
  state: WorkerState,
  config: BotConfig,
  trackKey: 'friendRequested' | 'imageSent' | 'groupPulled',
): Promise<{ member: GroupMember; groupLink: string } | null> {
  const progress = state.progress;

  for (let i = progress.currentGroupIndex; i < config.sourceGroupLinks.length; i++) {
    const groupLink = config.sourceGroupLinks[i];
    if (progress.completedGroups.includes(groupLink)) continue;

    // Scan members (cache)
    if (state.cachedGroupLink !== groupLink) {
      try {
        const result = await scanGroupMembers(api, groupLink);
        state.cachedGroupLink = groupLink;
        state.cachedMembers = result.members;
        state.cachedGroupName = result.groupName;
        log(state.accountId, `👥 Scanned "${result.groupName}": ${result.members.length} members`);
      } catch (e: any) {
        log(state.accountId, `❌ Scan error: ${e.message}`);
        progress.currentGroupIndex = i + 1;
        saveProgress(progress);
        continue;
      }
    }

    const doneIds = new Set(progress[trackKey][groupLink] || []);
    const unsent = state.cachedMembers.filter(m => !doneIds.has(m.id));

    if (unsent.length === 0) {
      // Group này đã xong cho action này, nhưng không đánh dấu completedGroups
      // vì có thể action khác chưa xong
      progress.currentGroupIndex = i + 1;
      state.cachedGroupLink = '';
      saveProgress(progress);
      continue;
    }

    return { member: unsent[0], groupLink };
  }

  return null;
}

function markDone(progress: AccountProgress, trackKey: string, groupLink: string, userId: string): void {
  if (!(progress as any)[trackKey][groupLink]) (progress as any)[trackKey][groupLink] = [];
  (progress as any)[trackKey][groupLink].push(userId);
}

// ═══════════════════════════════════════════════════
// ACTION 1: GỬI LỜI MỜI KẾT BẠN
// ═══════════════════════════════════════════════════

async function doFriendRequest(api: any, state: WorkerState, config: BotConfig): Promise<void> {
  if (!state.running || !isActiveHours(config)) return;

  const progress = state.progress;
  resetDailyIfNeeded(progress);

  if (progress.friendRequestDaily >= config.limits.friendRequestsPerDay) {
    log(state.accountId, `⏸️ FR: Đạt limit ${config.limits.friendRequestsPerDay}/ngày`);
    return;
  }

  const next = await findNextMember(api, state, config, 'friendRequested');
  if (!next) {
    log(state.accountId, '⏸️ FR: Hết member');
    return;
  }

  try {
    await api.sendFriendRequest(config.friendRequestMessage, next.member.id);
    progress.friendRequestDaily++;
    log(state.accountId, `✅ FR [${progress.friendRequestDaily}/${config.limits.friendRequestsPerDay}] → ${next.member.name}`);
  } catch (e: any) {
    // Error 225 = đã là bạn, 214 = đã gửi trước đó, 311 = API bug nhưng đã gửi
    if ([225, 214, 311].includes(e.code)) {
      progress.friendRequestDaily++;
      log(state.accountId, `✅ FR [${progress.friendRequestDaily}] ${next.member.name} (${e.code}: ${e.message})`);
    } else {
      log(state.accountId, `❌ FR ${next.member.name}: ${e.message}`);
    }
  }

  markDone(progress, 'friendRequested', next.groupLink, next.member.id);
  saveProgress(progress);

  // Schedule next
  if (state.running && progress.friendRequestDaily < config.limits.friendRequestsPerDay) {
    const delay = randomDelay(config.delays.friendRequestMin, config.delays.friendRequestMax);
    log(state.accountId, `⏰ FR next in ${Math.round(delay / 60000)}min`);
    state.timers.friendRequest = setTimeout(() => doFriendRequest(api, state, config), delay);
  }
}

// ═══════════════════════════════════════════════════
// ACTION 2: GỬI HÌNH MỜI VÀO GROUP
// ═══════════════════════════════════════════════════

async function doImageSend(api: any, state: WorkerState, config: BotConfig): Promise<void> {
  if (!state.running || !isActiveHours(config)) return;

  const progress = state.progress;
  resetDailyIfNeeded(progress);

  if (progress.imageSendDaily >= config.limits.imageSendsPerDay) {
    log(state.accountId, `⏸️ IMG: Đạt limit ${config.limits.imageSendsPerDay}/ngày`);
    return;
  }

  const imagePath = path.resolve('./data', config.inviteImagePath);
  if (!fs.existsSync(imagePath)) {
    log(state.accountId, `❌ IMG: Không tìm thấy hình: ${imagePath}`);
    return;
  }

  const next = await findNextMember(api, state, config, 'imageSent');
  if (!next) {
    log(state.accountId, '⏸️ IMG: Hết member');
    return;
  }

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const metadata = await sharp(imageBuffer).metadata();

    await api.sendMessage(
      {
        msg: '',
        attachments: [{
          filename: 'invite.jpg',
          data: imageBuffer,
          metadata: {
            width: metadata.width || 800,
            height: metadata.height || 600,
            totalSize: imageBuffer.length,
          },
        }],
      },
      next.member.id,
      0, // 0 = user/stranger
    );

    progress.imageSendDaily++;
    log(state.accountId, `✅ IMG [${progress.imageSendDaily}/${config.limits.imageSendsPerDay}] → ${next.member.name}`);
  } catch (e: any) {
    log(state.accountId, `❌ IMG ${next.member.name}: ${e.message}`);
  }

  markDone(progress, 'imageSent', next.groupLink, next.member.id);
  saveProgress(progress);

  // Schedule next
  if (state.running && progress.imageSendDaily < config.limits.imageSendsPerDay) {
    const delay = randomDelay(config.delays.imageSendMin, config.delays.imageSendMax);
    log(state.accountId, `⏰ IMG next in ${Math.round(delay / 60000)}min`);
    state.timers.imageSend = setTimeout(() => doImageSend(api, state, config), delay);
  }
}

// ═══════════════════════════════════════════════════
// ACTION 3: KÉO MEMBER VÀO GROUP ĐÍCH
// ═══════════════════════════════════════════════════

async function doGroupPull(api: any, state: WorkerState, config: BotConfig): Promise<void> {
  if (!state.running || !isActiveHours(config)) return;
  if (!config.targetGroupLink) {
    log(state.accountId, '⏸️ PULL: Chưa set targetGroupLink');
    return;
  }

  const progress = state.progress;
  resetDailyIfNeeded(progress);

  if (progress.groupPullDaily >= config.limits.groupPullsPerDay) {
    log(state.accountId, `⏸️ PULL: Đạt limit ${config.limits.groupPullsPerDay}/ngày`);
    return;
  }

  const next = await findNextMember(api, state, config, 'groupPulled');
  if (!next) {
    log(state.accountId, '⏸️ PULL: Hết member');
    return;
  }

  try {
    // Resolve target group ID
    const targetInfo = await api.getGroupLinkInfo({ link: config.targetGroupLink, memberPage: 1 });
    if (!targetInfo?.groupId) throw new Error('Không resolve được group đích');

    // Thử invite
    const result = await api.inviteUserToGroups(next.member.id, targetInfo.groupId);
    const groupResult = result?.grid_message_map?.[targetInfo.groupId];

    if (groupResult?.error_code && groupResult.error_code !== 0) {
      // Fallback
      await api.addUserToGroup(next.member.id, targetInfo.groupId);
    }

    progress.groupPullDaily++;
    log(state.accountId, `✅ PULL [${progress.groupPullDaily}/${config.limits.groupPullsPerDay}] → ${next.member.name}`);
  } catch (e: any) {
    log(state.accountId, `❌ PULL ${next.member.name}: ${e.message}`);
  }

  markDone(progress, 'groupPulled', next.groupLink, next.member.id);
  saveProgress(progress);

  // Schedule next
  if (state.running && progress.groupPullDaily < config.limits.groupPullsPerDay) {
    const delay = randomDelay(config.delays.groupPullMin, config.delays.groupPullMax);
    log(state.accountId, `⏰ PULL next in ${Math.round(delay / 60000)}min`);
    state.timers.groupPull = setTimeout(() => doGroupPull(api, state, config), delay);
  }
}

// ═══════════════════════════════════════════════════
// WORKER LIFECYCLE
// ═══════════════════════════════════════════════════

/**
 * Start worker cho 1 account
 */
export function startWorker(api: any, accountId: string, accountName: string, config: BotConfig): void {
  if (workers.has(accountId)) {
    console.log(`⚠️ Worker ${accountId} đã chạy rồi`);
    return;
  }

  const state: WorkerState = {
    running: true,
    accountId,
    accountName,
    progress: loadProgress(accountId),
    timers: { friendRequest: null, imageSend: null, groupPull: null },
    cachedGroupLink: '',
    cachedMembers: [],
    cachedGroupName: '',
  };

  workers.set(accountId, state);
  log(accountId, `🚀 Worker started cho ${accountName}`);

  // Kiểm tra active hours mỗi phút, start actions khi vào giờ
  const checkInterval = setInterval(() => {
    if (!state.running) {
      clearInterval(checkInterval);
      return;
    }

    if (isActiveHours(config)) {
      // Start actions nếu chưa có timer
      if (!state.timers.friendRequest && state.progress.friendRequestDaily < config.limits.friendRequestsPerDay) {
        doFriendRequest(api, state, config);
      }
      if (!state.timers.imageSend && state.progress.imageSendDaily < config.limits.imageSendsPerDay) {
        doImageSend(api, state, config);
      }
      if (!state.timers.groupPull && state.progress.groupPullDaily < config.limits.groupPullsPerDay) {
        doGroupPull(api, state, config);
      }
    }
  }, 60 * 1000);

  // Start ngay nếu đang trong giờ
  if (isActiveHours(config)) {
    setTimeout(() => doFriendRequest(api, state, config), 1000);
    setTimeout(() => doImageSend(api, state, config), 5000);
    setTimeout(() => doGroupPull(api, state, config), 10000);
  } else {
    log(accountId, `⏸️ Ngoài giờ hoạt động (${config.activeHours.start}h-${config.activeHours.end}h VN), chờ...`);
  }
}

/**
 * Stop worker
 */
export function stopWorker(accountId: string): void {
  const state = workers.get(accountId);
  if (!state) return;

  state.running = false;
  if (state.timers.friendRequest) clearTimeout(state.timers.friendRequest);
  if (state.timers.imageSend) clearTimeout(state.timers.imageSend);
  if (state.timers.groupPull) clearTimeout(state.timers.groupPull);
  workers.delete(accountId);
  log(accountId, '🛑 Worker stopped');
}

/**
 * Stop tất cả workers
 */
export function stopAllWorkers(): void {
  for (const [id] of workers) stopWorker(id);
}

/**
 * Lấy status tất cả workers
 */
export function getWorkersStatus(): Array<{
  accountId: string;
  accountName: string;
  friendRequestDaily: number;
  imageSendDaily: number;
  groupPullDaily: number;
  running: boolean;
}> {
  return Array.from(workers.values()).map(w => ({
    accountId: w.accountId,
    accountName: w.accountName,
    friendRequestDaily: w.progress.friendRequestDaily,
    imageSendDaily: w.progress.imageSendDaily,
    groupPullDaily: w.progress.groupPullDaily,
    running: w.running,
  }));
}
