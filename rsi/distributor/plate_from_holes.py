#!/usr/bin/env python3
"""把 holes.json（[[x_m, y_m, d_mm], ...]，已锁定 5 % 开孔率）映射到 plate faceZone 的网格面：
每个面归最近的孔，按距离由近到远填充到孔面积配额，舍入误差顺延到下一孔 → 总开孔率误差 < 1 个面。
输出 constant/polyMesh/sets/plateFaces（挡板面）与 distributor_info.json。在 createBaffles 之前运行，网格须为 ascii。"""
import re, sys, json, math, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
G = json.load(open(os.path.join(HERE, 'contract.json'), encoding='utf-8'))['locked_geometry']
R_R, R_M, PHI = G['R_R'], G['R_M'], G['opening_ratio']
pm = 'constant/polyMesh/'


def body(f):
    t = open(pm + f, errors='replace').read()
    hdr = t[t.find('FoamFile'):t.find('}', t.find('FoamFile'))]
    if re.search(r'format\s+binary', hdr): sys.exit(f'{f}: binary polyMesh 不支持')
    t = t[t.find('}', t.find('FoamFile')) + 1:]
    m = re.search(r'\n\s*(\d+)\s*\n\s*\(', t)
    return int(m.group(1)), t[m.end():]


def main():
    holes = json.load(open('holes.json'))['holes']
    H = np.array([[h[0], h[1]] for h in holes]); quota = np.array([math.pi * (h[2] * 1e-3) ** 2 / 4 for h in holes])
    npnt, b = body('points')
    P = np.array([list(map(float, s.split())) for s in re.findall(r'\(([^()]*)\)', b)[:npnt]])
    nf, b = body('faces')
    F = [list(map(int, s.split())) for s in re.findall(r'\d+\(([^()]*)\)', b)[:nf]]
    nInt, _ = body('neighbour')
    zt = open(pm + 'faceZones', errors='replace').read()
    zm = re.search(r'\bplate\s*\{.*?faceLabels\s+(?:List<label>\s+)?(\d+)\s*\((.*?)\)', zt, re.S)
    if not zm: sys.exit('faceZones 中找不到 plate 区')
    zfaces = np.array(zm.group(2).split(), int)[:int(zm.group(1))]
    cand, area, cen = [], [], []
    for i in zfaces:
        if i >= nInt: continue
        pts = P[F[i]]
        if np.abs(pts[:, 2]).max() > 0.01: continue
        c = pts.mean(0)
        if math.hypot(c[0], c[1]) > R_R - 1e-3:
            cand.append(i); cen.append(c[:2])
            area.append(0.5 * np.linalg.norm(np.cross(pts[1:-1] - pts[0], pts[2:] - pts[0]).sum(0)))
    if not cand: sys.exit('plate 区无内部面：须在 createBaffles 之前运行')
    cand, area, cen = np.array(cand), np.array(area), np.array(cen)
    Aring = area.sum()
    # 配额按网格实际环面积重标定，保证网格上的开孔率 = PHI
    quota = quota * (PHI * Aring / quota.sum())
    # 逐孔贪心：每个孔先拿离孔心最近的未开面（保证每孔至少 1 个面），再按距离加面直到配额；
    # 舍入误差顺延到下一孔 → 总开孔率误差 < 1 个面。孔约等于 1 个面时（粗网格上的 211 孔）也不会丢孔。
    d = np.linalg.norm(cen[:, None, :] - H[None, :, :], axis=2)
    opened = np.zeros(len(cand), bool); got = np.zeros(len(H)); carry = 0.0
    for h in np.argsort(-quota, kind='stable'):
        target = quota[h] + carry
        order = [i for i in np.argsort(d[:, h])[:12] if not opened[i]]
        if order:
            # 第一个面：最近 4 个未开面里面积最接近配额的（单面孔时决定开孔率）
            near = order[:4]; first = min(near, key=lambda i: abs(area[i] - target))
            opened[first] = True; got[h] += area[first]
        for i in np.argsort(d[:, h]):
            if opened[i]: continue
            if got[h] > 0 and got[h] + 0.5 * area[i] > target: break
            opened[i] = True; got[h] += area[i]
            if d[i, h] > 0.5 * math.sqrt(quota[h] / math.pi) + 2 * math.sqrt(np.median(area)): break
        carry = target - got[h]
    phi_real = area[opened].sum() / Aring
    closed = cand[~opened]
    os.makedirs(pm + 'sets', exist_ok=True)
    with open(pm + 'sets/plateFaces', 'w') as f:
        f.write('FoamFile { version 2.0; format ascii; class faceSet; location "constant/polyMesh/sets"; object plateFaces; }\n')
        f.write(f'{len(closed)}\n(\n' + '\n'.join(map(str, closed)) + '\n)\n')
    ok = got > 0
    r_open = np.hypot(cen[opened, 0], cen[opened, 1])
    info = dict(ring_faces=int(len(cand)), ring_area=float(Aring), open_faces=int(opened.sum()), holes_requested=int(len(H)),
                holes_realised=int(ok.sum()), opening_ratio=float(phi_real),
                hole_area_rel_err_max=float(np.max(np.abs(got[ok] / quota[ok] - 1))) if ok.any() else 1.0,
                open_area_r_mean_m=float((r_open * area[opened]).sum() / max(area[opened].sum(), 1e-30)),
                face_area_median_mm2=float(np.median(area) * 1e6))
    json.dump(info, open('distributor_info.json', 'w'), indent=1)
    print(json.dumps(info))
    if abs(phi_real - PHI) / PHI > 0.05: sys.exit(f'网格开孔率 {phi_real:.4f} 偏离 {PHI} 超过 5 %')
    if ok.sum() < len(H): sys.exit(f'只有 {int(ok.sum())}/{len(H)} 个孔分到网格面：孔太小，网格分辨不了')


if __name__ == '__main__':
    main()
