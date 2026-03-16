/**
 * Config - Sale Bot BĐS cho thuê
 * 
 * Chỉnh sửa file config.json trong thư mục data/ để thay đổi cấu hình.
 * Nếu chưa có file, bot sẽ tạo mặc định.
 */

import fs from 'node:fs';
import path from 'node:path';

// ═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════

export interface BotConfig {
  // Danh sách group nguồn để quét member (dùng chung nếu account không có riêng)
  sourceGroupLinks: string[];
  // Source groups riêng cho từng account: accountId → [groupLinks]
  accountSourceGroups: Record<string, string[]>;
  // Group đích để mời member về
  targetGroupLink: string;
  // Hình ảnh gửi cho member (đường dẫn relative từ data/)
  inviteImagePath: string;
  // Tin nhắn kèm lời mời kết bạn
  friendRequestMessage: string;
  // Giới hạn
  limits: {
    friendRequestsPerDay: number;   // Số lời mời kết bạn / ngày / account
    imageSendsPerDay: number;       // Số hình gửi / ngày / account
    groupPullsPerDay: number;       // Số member kéo vào group / ngày / account
  };
  // Thời gian hoạt động (giờ VN)
  activeHours: {
    start: number; // 7
    end: number;   // 22
  };
  // Delay giữa các action (phút)
  delays: {
    friendRequestMin: number;
    friendRequestMax: number;
    imageSendMin: number;
    imageSendMax: number;
    groupPullMin: number;
    groupPullMax: number;
  };
}

// ═══════════════════════════════════════════════════
// DEFAULT CONFIG
// ═══════════════════════════════════════════════════

const DEFAULT_CONFIG: BotConfig = {
  sourceGroupLinks: [
    'https://zalo.me/g/tuwpbw027',
  ],
  accountSourceGroups: {
    '624477080503635119': ['https://zalo.me/g/tuwpbw027'],   // An Nhiên
    '620536444087160751': ['https://zalo.me/g/fecfcv625'],  // Tú Nhi
  },
  targetGroupLink: 'https://zalo.me/g/hywbhw272',
  inviteImagePath: 'images/invite.jpg',
  friendRequestMessage: '🏠 CHDV 71A Nguyễn Thượng Hiền (Quận Bình Thạnh cũ) - Phòng đẹp giá tốt, tham gia nhóm xem phòng trống nhé! 👉 https://zalo.me/g/hywbhw272 📞 0329 407 073',
  limits: {
    friendRequestsPerDay: 100,
    imageSendsPerDay: 100,
    groupPullsPerDay: 20,
  },
  activeHours: {
    start: 7,
    end: 23,
  },
  delays: {
    friendRequestMin: 5,
    friendRequestMax: 18,
    imageSendMin: 5,
    imageSendMax: 18,
    groupPullMin: 30,
    groupPullMax: 60,
  },
};

// ═══════════════════════════════════════════════════
// LOAD / SAVE
// ═══════════════════════════════════════════════════

const DATA_DIR = path.resolve('./data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const imagesDir = path.join(DATA_DIR, 'images');
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
}

export function loadConfig(): BotConfig {
  ensureDataDir();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...raw, accountSourceGroups: { ...DEFAULT_CONFIG.accountSourceGroups, ...raw.accountSourceGroups }, limits: { ...DEFAULT_CONFIG.limits, ...raw.limits }, activeHours: { ...DEFAULT_CONFIG.activeHours, ...raw.activeHours }, delays: { ...DEFAULT_CONFIG.delays, ...raw.delays } };
    }
  } catch (e) {
    console.error('⚠️ Lỗi đọc config.json, dùng mặc định');
  }
  // Tạo file mặc định
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  console.log(`📝 Đã tạo config mặc định: ${CONFIG_PATH}`);
  return DEFAULT_CONFIG;
}

export function saveConfig(config: BotConfig): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
