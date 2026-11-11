// 把对话里提到的路径解析成工作区内真实存在的文件：界面据此把路径变成可点击链接、把图片内联显示。
// 只返回工作区内、确实存在的路径；不存在的一律不返回（界面保持纯文本）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SKIP_DIR = /^(processor\d+|dynamicCode|polyMesh|node_modules|__pycache__|VTK|\..*|\d+(\.\d+)?(e-?\d+)?)$/i;
const inside = (root, f) => { const r = path.relative(root, f); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const toRel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const statOrNull = async f => { try { return await fs.stat(f); } catch (e) { return null; } };

// 文件名 → 所在位置（只往下找 depth 层，跳过分解场、时间步等海量目录）
async function nameIndex(dir, depth, index, budget) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (budget.left-- <= 0) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP_DIR.test(e.name)) await nameIndex(full, depth - 1, index, budget); }
    else if (e.isFile()) { if (!index.has(e.name)) index.set(e.name, new Set()); index.get(e.name).add(full); }
  }
}

// paths：对话里出现的原始写法；bases：可能的基准目录（当前算例目录、最近产物所在目录），相对工作区或绝对路径。
// 带目录的写法先按工作区相对解析；只有文件名的先在基准目录里找，再在基准目录下 3 层内按文件名找（唯一才算）。
export async function resolveMentioned({ workspace, paths, bases = [] }) {
  const root = path.resolve(workspace);
  const home = os.homedir();
  const baseDirs = [];
  for (const b of bases) {
    if (typeof b !== 'string' || !b) continue;
    const abs = path.resolve(root, b.replace(/^~(?=[\\/])/, home));
    if (inside(root, abs) && abs !== root && !baseDirs.includes(abs)) baseDirs.push(abs);
    if (baseDirs.length >= 8) break;
  }
  const found = Object.create(null);
  let index = null;
  for (const raw of (Array.isArray(paths) ? paths : []).slice(0, 80)) {
    if (typeof raw !== 'string' || !raw || raw.length > 400 || raw.includes('\0') || raw in found) continue;
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^~(?=\/)/, home.replace(/\\/g, '/'));
    if (!p) continue;
    const bare = !p.includes('/');
    const order = path.isAbsolute(p) ? [root] : bare ? [...baseDirs, root] : [root, ...baseDirs];
    let hit = null;
    for (const b of order) {
      const f = path.resolve(b, p);
      if (!inside(root, f) || f === root) continue;
      const st = await statOrNull(f);
      if (st) { hit = { f, st }; break; }
    }
    if (!hit && bare && baseDirs.length) {
      if (!index) {
        index = new Map();
        const budget = { left: 6000 };
        for (const b of baseDirs.slice(0, 3)) await nameIndex(b, 3, index, budget);
      }
      const set = index.get(p);
      if (set && set.size === 1) { const f = [...set][0]; const st = await statOrNull(f); if (st) hit = { f, st }; }
    }
    if (hit) found[raw] = { path: toRel(root, hit.f), isDir: hit.st.isDirectory(), size: hit.st.size, mtime: hit.st.mtimeMs };
  }
  return found;
}
