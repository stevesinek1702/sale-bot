/**
 * Group Scanner - Quét thành viên từ group Zalo
 */

export interface GroupMember {
  id: string;
  name: string;
}

export interface ScanResult {
  members: GroupMember[];
  groupId: string;
  groupName: string;
}

/**
 * Quét tất cả thành viên từ 1 group link
 * Bỏ qua admin, creator, và bot
 */
export async function scanGroupMembers(api: any, groupLink: string): Promise<ScanResult> {
  const members = new Map<string, GroupMember>();

  const page1 = await api.getGroupLinkInfo({ link: groupLink, memberPage: 1 });
  if (!page1?.groupId) {
    throw new Error(`Không lấy được info group: ${groupLink}`);
  }

  const skipIds = new Set<string>([
    page1.creatorId || '',
    api.getContext?.()?.uid || '',
    ...(page1.adminIds || []),
  ]);

  // Process members từ tất cả pages
  const processMembers = (mems: any[]) => {
    for (const m of mems) {
      const id = String(m.id);
      if (skipIds.has(id)) continue;
      members.set(id, { id, name: m.dName || m.zaloName || 'Unknown' });
    }
  };

  if (page1.currentMems) processMembers(page1.currentMems);

  let page = 1;
  let hasMore = page1.hasMoreMember === 1;
  while (hasMore && page < 50) {
    page++;
    await sleep(500);
    try {
      const pageData = await api.getGroupLinkInfo({ link: groupLink, memberPage: page });
      if (pageData.currentMems?.length > 0) {
        processMembers(pageData.currentMems);
        hasMore = pageData.hasMoreMember === 1;
      } else {
        hasMore = false;
      }
    } catch {
      hasMore = false;
    }
  }

  return {
    members: Array.from(members.values()),
    groupId: page1.groupId,
    groupName: page1.name || 'Unknown',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
