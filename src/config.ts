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
  // Danh sách group nguồn để quét member
  sourceGroupLinks: string[];
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
  targetGroupLink: 'https://zalo.me/g/hywbhw272',
  inviteImagePath: 'images/invite.jpg',
  friendRequestMessage: '🏠CHDV 71A Nguyễn Thượng Hiền (quận Bình Thạnh cũ) 🗝️ Tham gia nhóm để xem thông tin phòng trống. Tel 0329 407 073',
  limits: {
    friendRequestsPerDay: 50,
    imageSendsPerDay: 50,
    groupPullsPerDay: 20,
  },
  activeHours: {
    start: 7,
    end: 22,
  },
  delays: {
    friendRequestMin: 30,
    friendRequestMax: 60,
    imageSendMin: 3,
    imageSendMax: 10,
    groupPullMin: 30,
    groupPullMax: 90,
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
      return { ...DEFAULT_CONFIG, ...raw, limits: { ...DEFAULT_CONFIG.limits, ...raw.limits }, activeHours: { ...DEFAULT_CONFIG.activeHours, ...raw.activeHours }, delays: { ...DEFAULT_CONFIG.delays, ...raw.delays } };
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
