/**
 * Git Sync - Tự động push thay đổi lên GitHub qua API
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'stevesinek1702/sale-bot';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;

function log(msg: string) {
  const t = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`[${t}] [GIT] ${msg}`);
}

async function ghFetch(path: string, method = 'GET', body?: any): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub ${method} ${path}: ${res.status} ${err.substring(0, 200)}`);
  }
  return res.json();
}

/**
 * Push nhiều files lên GitHub trong 1 commit
 */
export async function pushFilesToGitHub(
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<void> {
  if (!GITHUB_TOKEN) {
    log('⚠️ GITHUB_TOKEN chưa set, bỏ qua sync');
    return;
  }

  try {
    // 1. Lấy HEAD commit SHA
    const ref = await ghFetch(`/git/ref/heads/${GITHUB_BRANCH}`);
    const headSha = ref.object.sha;

    // 2. Lấy base tree SHA
    const commit = await ghFetch(`/git/commits/${headSha}`);
    const baseTreeSha = commit.tree.sha;

    // 3. Tạo blobs
    const treeItems = await Promise.all(files.map(async (f) => {
      const blob = await ghFetch('/git/blobs', 'POST', {
        content: Buffer.from(f.content).toString('base64'),
        encoding: 'base64',
      });
      return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));

    // 4. Tạo tree mới
    const newTree = await ghFetch('/git/trees', 'POST', {
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    // 5. Tạo commit
    const newCommit = await ghFetch('/git/commits', 'POST', {
      message,
      tree: newTree.sha,
      parents: [headSha],
    });

    // 6. Update branch ref
    await ghFetch(`/git/refs/heads/${GITHUB_BRANCH}`, 'PATCH', {
      sha: newCommit.sha,
    });

    log(`✅ Pushed ${files.length} file(s): ${message}`);
  } catch (e: any) {
    log(`❌ Push failed: ${e.message}`);
  }
}
