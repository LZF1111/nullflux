#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NullFlux v6 · STL 贴合度检查
比较 (a) 用户原始 STL 与 (b) OpenFOAM 网格 patch 经 surfaceMeshTriangulate 导出的 STL，
通过双向 Hausdorff 采样判断 snappyHexMesh 是否真的贴合几何，并对比 bbox / 表面积。

用法:
  python mesh_stl_check.py --ref orig.stl --mesh extracted.stl \
                           [--samples 5000] [--tol_mean_pct 2.0] [--json out.json]

最后一行 stdout 必为 JSON。失败也输出 JSON {"ok": false, "error": "..."}.
"""
import argparse, json, os, struct, sys, traceback
try:
    import numpy as np
except ImportError:
    print(json.dumps({'ok': False, 'error': 'numpy 未安装：请运行 `pip install numpy scipy` 后重试（scipy 可选，加速 KD-Tree）'}))
    sys.exit(0)

# ---------- STL 读取（ASCII / 二进制 自动判别） ----------
def load_stl(path):
    with open(path, 'rb') as f:
        head = f.read(512)
    is_ascii = head.lstrip().lower().startswith(b'solid') and b'facet normal' in head.lower()
    if is_ascii:
        return _load_ascii(path)
    return _load_binary(path)

def _load_ascii(path):
    tris = []
    with open(path, 'r', errors='ignore') as f:
        cur = []
        for line in f:
            s = line.strip()
            if s.startswith('vertex'):
                parts = s.split()
                cur.append([float(parts[1]), float(parts[2]), float(parts[3])])
                if len(cur) == 3:
                    tris.append(cur); cur = []
    return np.asarray(tris, dtype=np.float64)  # (N,3,3)

def _load_binary(path):
    with open(path, 'rb') as f:
        f.read(80)
        n = struct.unpack('<I', f.read(4))[0]
        data = f.read(n * 50)
    if len(data) < n * 50:
        raise RuntimeError(f'binary STL truncated: expected {n*50}, got {len(data)}')
    arr = np.frombuffer(data, dtype=np.uint8).reshape(n, 50)
    # bytes 0-11 normal, 12-47 vertices (3 x 3 floats), 48-49 attr
    verts = arr[:, 12:48].copy().view(np.float32).reshape(n, 3, 3).astype(np.float64)
    return verts

# ---------- 几何工具 ----------
def tri_areas(tris):
    a = tris[:, 1] - tris[:, 0]
    b = tris[:, 2] - tris[:, 0]
    return 0.5 * np.linalg.norm(np.cross(a, b), axis=1)

def sample_surface(tris, n, rng):
    """按面积加权在三角形上均匀采样 n 个点。"""
    areas = tri_areas(tris)
    total = areas.sum()
    if total <= 0:
        raise RuntimeError('退化 STL：总面积为 0')
    probs = areas / total
    idx = rng.choice(len(tris), size=n, p=probs)
    u = rng.random(n); v = rng.random(n)
    over = u + v > 1
    u[over] = 1 - u[over]; v[over] = 1 - v[over]
    w = 1 - u - v
    chosen = tris[idx]                                  # (n,3,3)
    pts = (chosen[:, 0] * w[:, None]
         + chosen[:, 1] * u[:, None]
         + chosen[:, 2] * v[:, None])
    return pts, total

def nearest_dist(pts_query, pts_target):
    """每个 query 点到 target 点云的最近距离。优先 scipy.cKDTree，否则 chunked numpy。"""
    try:
        from scipy.spatial import cKDTree
        tree = cKDTree(pts_target)
        d, _ = tree.query(pts_query, k=1)
        return d
    except Exception:
        # numpy 兜底：分块算距离矩阵
        out = np.empty(len(pts_query), dtype=np.float64)
        CHUNK = 256
        for i in range(0, len(pts_query), CHUNK):
            q = pts_query[i:i+CHUNK]                    # (c,3)
            diff = q[:, None, :] - pts_target[None, :, :]
            d2 = np.einsum('ijk,ijk->ij', diff, diff)
            out[i:i+CHUNK] = np.sqrt(d2.min(axis=1))
        return out

# ---------- 主逻辑 ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True, help='原始几何 STL（设计意图）')
    ap.add_argument('--mesh', required=True, help='OpenFOAM patch 导出 STL（snappy 实际生成）')
    ap.add_argument('--samples', type=int, default=5000)
    ap.add_argument('--tol_mean_pct', type=float, default=2.0,
                    help='mean 距离阈值占 bbox 对角线百分比（默认 2%%）')
    ap.add_argument('--tol_p95_pct', type=float, default=5.0)
    ap.add_argument('--tol_max_pct', type=float, default=10.0)
    ap.add_argument('--json', default=None)
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()

    result = {'ok': False, 'tool': 'foam_mesh_stl_check'}
    try:
        if not os.path.isfile(args.ref):
            raise FileNotFoundError(f'ref 不存在: {args.ref}')
        if not os.path.isfile(args.mesh):
            raise FileNotFoundError(f'mesh 不存在: {args.mesh}（surfaceMeshTriangulate 没产出？）')

        tris_ref = load_stl(args.ref)
        tris_mesh = load_stl(args.mesh)
        if len(tris_ref) == 0 or len(tris_mesh) == 0:
            raise RuntimeError(f'STL 空：ref={len(tris_ref)} tri, mesh={len(tris_mesh)} tri')

        # bbox & 对角线
        all_pts_ref = tris_ref.reshape(-1, 3)
        all_pts_mesh = tris_mesh.reshape(-1, 3)
        bb_ref = np.array([all_pts_ref.min(0), all_pts_ref.max(0)])
        bb_mesh = np.array([all_pts_mesh.min(0), all_pts_mesh.max(0)])
        L = float(np.linalg.norm(bb_ref[1] - bb_ref[0]))     # 参考 bbox 对角线
        if L <= 0:
            raise RuntimeError('参考 STL 退化（bbox 体积 0）')

        rng = np.random.default_rng(args.seed)
        pts_ref, area_ref = sample_surface(tris_ref, args.samples, rng)
        pts_mesh, area_mesh = sample_surface(tris_mesh, args.samples, rng)

        d_fwd = nearest_dist(pts_ref, pts_mesh)       # ref → mesh：原几何到网格的距离（缺失检查）
        d_rev = nearest_dist(pts_mesh, pts_ref)       # mesh → ref：网格冒出 STL 外的距离（鼓包检查）

        def stats(d):
            return {
                'mean': float(d.mean()),
                'p50':  float(np.percentile(d, 50)),
                'p95':  float(np.percentile(d, 95)),
                'p99':  float(np.percentile(d, 99)),
                'max':  float(d.max()),
            }
        s_fwd, s_rev = stats(d_fwd), stats(d_rev)
        haus = max(s_fwd['max'], s_rev['max'])
        mean_max = max(s_fwd['mean'], s_rev['mean'])
        p95_max  = max(s_fwd['p95'],  s_rev['p95'])

        # 比 bbox
        bb_diff = np.abs(bb_mesh - bb_ref)
        bb_diff_pct = float((bb_diff.max() / L) * 100)
        # 比表面积
        area_ratio = float(area_mesh / area_ref) if area_ref > 0 else 0.0

        # 判定
        mean_pct = mean_max / L * 100
        p95_pct  = p95_max  / L * 100
        haus_pct = haus     / L * 100
        issues = []
        if mean_pct > args.tol_mean_pct:
            issues.append(f'mean 距离 {mean_pct:.2f}% L 超过阈值 {args.tol_mean_pct}%（snap 阶段没贴上）')
        if p95_pct > args.tol_p95_pct:
            issues.append(f'p95 距离 {p95_pct:.2f}% L 超过阈值 {args.tol_p95_pct}%（局部锯齿/缺失）')
        if haus_pct > args.tol_max_pct:
            issues.append(f'最大距离（Hausdorff）{haus_pct:.2f}% L 超过 {args.tol_max_pct}% —— STL 大段没被网格覆盖或网格冒出 STL 外')
        if bb_diff_pct > 10:
            issues.append(f'bbox 偏差 {bb_diff_pct:.1f}% L —— 可能 locationInMesh 选反、或 STL 被吞')
        if area_ratio < 0.7:
            issues.append(f'patch 面积仅 {area_ratio*100:.0f}% × STL 面积 —— snappy 只贴了一部分（castellated 漏面 / refinement level 不够）')
        if area_ratio > 1.5:
            issues.append(f'patch 面积 {area_ratio*100:.0f}% × STL —— 出现锯齿放大 / 多余面（snap 失败 stair-step 残留）')

        pass_ = len(issues) == 0
        result.update({
            'ok': True,
            'pass': pass_,
            'ref_stl': args.ref,
            'mesh_stl': args.mesh,
            'bbox_ref': bb_ref.tolist(),
            'bbox_mesh': bb_mesh.tolist(),
            'bbox_diff_pct_of_L': round(bb_diff_pct, 3),
            'L_diag_ref': round(L, 6),
            'area_ref': round(area_ref, 6),
            'area_mesh': round(area_mesh, 6),
            'area_ratio_mesh_over_ref': round(area_ratio, 4),
            'forward_ref_to_mesh': s_fwd,
            'reverse_mesh_to_ref': s_rev,
            'hausdorff': round(haus, 6),
            'mean_pct_of_L': round(mean_pct, 3),
            'p95_pct_of_L':  round(p95_pct, 3),
            'hausdorff_pct_of_L': round(haus_pct, 3),
            'issues': issues,
            'tri_count_ref': int(len(tris_ref)),
            'tri_count_mesh': int(len(tris_mesh)),
            'samples': args.samples,
        })
    except Exception as e:
        result.update({'ok': False, 'error': str(e), 'trace': traceback.format_exc()[-800:]})

    s = json.dumps(result, ensure_ascii=False)
    if args.json:
        try:
            with open(args.json, 'w', encoding='utf-8') as f: f.write(s)
        except Exception: pass
    print(s)

if __name__ == '__main__':
    main()
