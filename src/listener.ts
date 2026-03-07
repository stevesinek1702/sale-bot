/**
 * Message & Event Listener - Lắng nghe tin nhắn và sự kiện Zalo
 * 
 * Tính năng:
 * 1. Auto trả lời tin nhắn (giới thiệu BĐS)
 * 2. Auto accept friend request → kéo vào group đích
 * 3. Auto gửi friend request cho stranger nhắn tin
 */

import { type BotConfig } from './config.js';

// Cache danh sách bạn bè
let friendsCache = new Set<string>();
let friendsCacheTime = 0;
const FRIENDS_CACHE_TTL = 5 * 60 * 1000; // 5 phút

// Track đã gửi FR
const sentFriendRequests = new Set<string>();

// Track đã trả lời (tránh spam)
const repliedUsers = new Map<string, number>(); // userId -> lastReplyTime
const REPLY_COOLDOWN = 30 * 60 * 1000; // 30 phút mới trả lời lại

function log(tag: string, msg: string): void {
  const time = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`[${time}] [${tag}] ${msg}`);
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Refresh cache bạn bè
 */
async function refreshFriendsCache(api: any): Promise<void> {
  if (Date.now() - friendsCacheTime < FRIENDS_CACHE_TTL) return;
  try {
    const data = await api.getAllFriends();
    friendsCache = new Set<string>();
    const list = Array.isArray(data) ? data : data?.data || [];
    for (const f of list) {
      const id = String(f.userId || f.uid || f.id);
      if (id) friendsCache.add(id);
    }
    friendsCacheTime = Date.now();
    log('FRIENDS', `Cache updated: ${friendsCache.size} bạn bè`);
  } catch (e: any) {
    log('FRIENDS', `Lỗi refresh cache: ${e.message}`);
  }
}

/**
 * Auto gửi friend request nếu stranger nhắn tin
 */
async function autoFriendRequest(api: any, userId: string, userName: string): Promise<void> {
  if (sentFriendRequests.has(userId)) return;
  
  await refreshFriendsCache(api);
  if (friendsCache.has(userId)) return;

  try {
    await randomDelay(2000, 5000);
    await api.sendFriendRequest(
      '🏠 Chào bạn! Mình có CHDV cho thuê giá tốt, kết bạn để mình tư vấn nhé!',
      userId,
    );
    sentFriendRequests.add(userId);
    log('AUTO_FR', `✅ Đã gửi FR → ${userName} (${userId})`);
  } catch (e: any) {
    if (e.code === -201 || e.code === 225) {
      friendsCache.add(userId);
    } else if (e.code === -213) {
      sentFriendRequests.add(userId);
    }
    log('AUTO_FR', `${userName}: ${e.message} (code: ${e.code})`);
  }
}

/**
 * Auto trả lời tin nhắn
 */
async function autoReply(api: any, threadId: string, senderId: string, config: BotConfig): Promise<void> {
  // Check cooldown
  const lastReply = repliedUsers.get(senderId) || 0;
  if (Date.now() - lastReply < REPLY_COOLDOWN) return;

  try {
    await randomDelay(1000, 3000);

    const msg = `🏠 CHDV 71A Nguyễn Thượng Hiền (quận Bình Thạnh cũ)
🗝️ Tham gia nhóm để xem thông tin phòng trống.

👉 ${config.targetGroupLink || 'https://zalo.me/g/hywbhw272'}

📞 Tel 0329 407 073

Cảm ơn bạn đã liên hệ!`;

    await api.sendMessage(msg, threadId, 0); // 0 = user
    repliedUsers.set(senderId, Date.now());
    log('REPLY', `✅ Đã trả lời → ${senderId}`);
  } catch (e: any) {
    log('REPLY', `❌ Lỗi trả lời ${senderId}: ${e.message}`);
  }
}

/**
 * Auto kéo user vào group đích sau khi accept FR
 */
async function autoAddToGroup(api: any, userId: string, userName: string, config: BotConfig): Promise<void> {
  if (!config.targetGroupLink) {
    log('PULL', '⚠️ Chưa set targetGroupLink');
    return;
  }

  try {
    await randomDelay(2000, 5000);

    // Resolve group ID
    const info = await api.getGroupLinkInfo({ link: config.targetGroupLink, memberPage: 1 });
    if (!info?.groupId) {
      log('PULL', '❌ Không resolve được group đích');
      return;
    }

    // Thử invite
    try {
      const result = await api.inviteUserToGroups(userId, info.groupId);
      const groupResult = result?.grid_message_map?.[info.groupId];
      if (groupResult?.error_code && groupResult.error_code !== 0) {
        await api.addUserToGroup(userId, info.groupId);
      }
    } catch {
      await api.addUserToGroup(userId, info.groupId);
    }

    log('PULL', `✅ Đã kéo ${userName} vào group đích`);
  } catch (e: any) {
    log('PULL', `❌ Lỗi kéo ${userName}: ${e.message}`);
  }
}

/**
 * Đăng ký tất cả listeners cho 1 account
 */
export function registerListeners(api: any, accountId: string, config: BotConfig): void {
  const shortId = accountId.slice(-4);

  // 1. Message listener - auto reply + auto FR
  api.listener.on('message', async (message: any) => {
    const threadId = message.threadId;
    const senderId = message.data?.uidFrom || threadId;
    const senderName = message.data?.dName || 'Unknown';
    const content = message.data?.content || '';

    // Bỏ qua tin nhắn của chính mình
    if (message.isSelf) return;

    // Chỉ xử lý tin nhắn 1-1 (type 0), bỏ qua group (type 1)
    if (message.type !== 0) return;

    log(`MSG:${shortId}`, `📨 ${senderName}: ${content.substring(0, 50)}`);

    // Auto friend request nếu chưa phải bạn bè
    await autoFriendRequest(api, senderId, senderName);

    // Auto trả lời
    await autoReply(api, threadId, senderId, config);
  });

  log(`LISTENER:${shortId}`, '📨 Message listener registered');

  // 2. Friend event listener - auto accept + auto pull to group
  api.listener.on('friend_event', async (event: any) => {
    const type = event.type;

    // Type 0 = ADD (friend accepted)
    if (type === 0) {
      if (event.isSelf) return; // Bot tự accept thì bỏ qua

      const userId = event.data?.fromUid || event.data?.uid;
      const displayName = event.data?.displayName || event.data?.zaloName || 'Bạn mới';
      if (!userId) return;

      log(`FRIEND:${shortId}`, `🤝 ${displayName} đã accept FR`);
      await autoAddToGroup(api, userId, displayName, config);
      return;
    }

    // Type 2 = REQUEST (có người gửi FR cho bot)
    if (type === 2) {
      if (event.isSelf) return;

      const fromUid = event.data?.fromUid;
      const displayName = event.data?.displayName || event.data?.zaloName || 'Người lạ';
      if (!fromUid) return;

      log(`FRIEND:${shortId}`, `💌 Nhận FR từ: ${displayName}`);

      try {
        await randomDelay(2000, 5000);
        await api.acceptFriendRequest(fromUid);
        friendsCache.add(fromUid);
        log(`FRIEND:${shortId}`, `✅ Đã accept: ${displayName}`);

        // Kéo vào group đích
        await autoAddToGroup(api, fromUid, displayName, config);
      } catch (e: any) {
        if (e.code === 225) {
          log(`FRIEND:${shortId}`, `ℹ️ ${displayName} đã là bạn bè`);
        } else {
          log(`FRIEND:${shortId}`, `❌ Lỗi accept ${fromUid}: ${e.message}`);
        }
      }
    }
  });

  log(`LISTENER:${shortId}`, '👥 Friend event listener registered');

  // 3. Start listener
  api.listener.start();
  log(`LISTENER:${shortId}`, '🎧 Listener started - đang lắng nghe tin nhắn...');
}
