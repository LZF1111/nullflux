// 启动求解器前的算例体检：只读，返回需要智能体在启动前处理的问题（避免算到一半才发现、停机重算）
import fs from 'node:fs/promises';
import path from 'node:path';

const num = (txt, key) => { const m = txt.match(new RegExp(`^\\s*${key}\\s+([^;\\s]+)\\s*;`, 'm')); return m ? m[1] : null; };

export function checkControlDict(txt) {
  const issues = [];
  const adj = /^\s*adjustTimeStep\s+(on|yes|true)\s*;/m.test(txt);
  const wc = num(txt, 'writeControl');
  const endTime = Number(num(txt, 'endTime'));
  const wi = Number(num(txt, 'writeInterval'));
  const start = Number(num(txt, 'startTime') || 0);
  if (adj && wc && !/^adjustable(RunTime)?$/.test(wc)) {
    issues.push(`adjustTimeStep on 但 writeControl=${wc}：时间步自适应时不会精确落在写出时刻，最终时刻（如 endTime=${num(txt, 'endTime')}）的场目录可能不写出。改为 writeControl adjustableRunTime;`);
  }
  if (wc && /runtime/i.test(wc) && Number.isFinite(endTime) && Number.isFinite(wi) && wi > 0) {
    const k = (endTime - start) / wi;
    if (Math.abs(k - Math.round(k)) > 1e-6) issues.push(`(endTime - startTime)=${endTime - start} 不是 writeInterval=${wi} 的整数倍：最后时刻不会写出场。`);
  }
  return { issues, facts: { adjustTimeStep: adj, writeControl: wc, endTime: num(txt, 'endTime'), writeInterval: num(txt, 'writeInterval'), deltaT: num(txt, 'deltaT') } };
}

// 0/ 下温度、压力场的 internalField（用于和任务工况核对，教程模板常是 600 K 等非常温值）
export function internalOf(txt) {
  const m = txt.match(/^\s*internalField\s+uniform\s+([^;]+);/m);
  return m ? m[1].trim() : (/^\s*internalField\s+nonuniform/m.test(txt) ? 'nonuniform' : null);
}

export async function prelaunchCheck(casePath) {
  const out = { issues: [], facts: {} };
  try {
    const r = checkControlDict(await fs.readFile(path.join(casePath, 'system', 'controlDict'), 'utf8'));
    out.issues.push(...r.issues); Object.assign(out.facts, r.facts);
  } catch {}
  let zero = path.join(casePath, '0');
  try { await fs.stat(zero); } catch { zero = null; }
  if (zero) {
    let names = [];
    try { names = await fs.readdir(zero); } catch {}
    for (const n of names) {
      if (!/^(T|p|p_rgh)(\.\w+)?$/.test(n)) continue;
      try { const v = internalOf(await fs.readFile(path.join(zero, n), 'utf8')); if (v) out.facts[`0/${n}`] = v; } catch {}
    }
  }
  return out;
}

export function formatPrelaunch(r) {
  const f = Object.entries(r.facts).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join('  ');
  let s = f ? `\n[启动前体检] ${f}\n  ↳ 请确认初始温度/压力与任务工况一致（教程模板常为非常温值）。` : '';
  if (r.issues.length) s += `\n[启动前体检 ⚠] ${r.issues.join('\n  ')}`;
  return s;
}
