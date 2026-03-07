/**
 * CLI Tool - Thêm tài khoản Zalo bằng QR
 * Chạy: bun src/add-account.ts
 * Hoặc: bun src/add-account.ts "Tên account"
 */

import { accounts } from './account.js';

const label = process.argv[2] || undefined;

console.log('═══════════════════════════════════════');
console.log('  🏠 Sale Bot BĐS - Thêm tài khoản');
console.log('═══════════════════════════════════════');
console.log('');

const result = await accounts.addByQR(label);

if (result.success) {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`  ✅ Thành công!`);
  console.log(`  👤 ${result.account!.name}`);
  console.log(`  🏷️ ${result.account!.label}`);
  console.log(`  🆔 ${result.account!.id}`);
  console.log('═══════════════════════════════════════');

  const total = accounts.count();
  console.log(`\n📊 Tổng: ${total} tài khoản`);
  console.log('\n👉 Chạy "bun start" để khởi động bot');
} else {
  console.error(`\n❌ Lỗi: ${result.error}`);
  if (result.qrPath) {
    console.log(`📱 QR tại: ${result.qrPath}`);
    console.log('👉 Mở file QR và quét bằng Zalo');
  }
}
