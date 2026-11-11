#!/usr/bin/env python3
"""Lu 2017 (CES 171:244) 各尺度 DMTO 反应器 2D 轴对称 wedge(5°) 算例生成器。
用法: gen_scale.py <scale> <dest> [np]    scale = pilot | demo | commercial
只读 ~/mto_repro/cases/pilot2D（取 fvSchemes/fvSolution/湍流/颗粒物性模板），不改它。
工况取 Table 1，曳力取附录 Table A2/A3/A4（EMMSscale），动力学 k/α 见 KIN，初值取 CSTR (cstr_mto.solve)。"""
import json, math, os, re, shutil, sys
sys.path.insert(0, os.path.expanduser('~/mto_repro/cstr'))
import numpy as np
import cstr_mto as C

TPL = os.path.expanduser('~/mto_repro/cases/pilot2D')
# 几何 (y_top, r_top, ny)，自下而上，y=0 为分布板；Fig.2 尺寸
GEOM = {
    'pilot': dict(NR=26, secs=[(0.0, 0.1305, 0), (1.347, 0.1305, 270), (1.747, 0.295, 50), (2.697, 0.295, 76), (2.897, 0.1575, 16)]),
    'demo': dict(NR=40, secs=[(0.0, 0.625, 0), (4.0, 0.625, 250), (4.96, 0.975, 48), (6.62, 0.975, 83)]),
    'commercial': dict(NR=70, secs=[(0.0, 5.25, 0), (8.0, 5.25, 160), (16.2, 8.1, 82), (26.2, 8.1, 100)]),
}
# Table 1：T K, 顶部表压 MPa, MeOH kg/h, 蒸汽 kg/h, 新鲜剂 kg/h, 藏量 kg；mu 取 Table A2/A3/A4
OP = {
    'pilot': dict(T=738., pg=0.024, meoh=18., steam=9.12, gs=8.8, inv=9., mu=2.43e-5, wc_in=2.0, end=100., avg=(60., 100.)),
    'demo': dict(T=773., pg=0.103, meoh=2032., steam=610., gs=351., inv=501., mu=2.67e-5, wc_in=0.0, end=100., avg=(60., 100.)),
    'commercial': dict(T=748., pg=0.108, meoh=241000., steam=60250., gs=42000., inv=56000., mu=2.563e-5, wc_in=0.0, end=150., avg=(90., 150.)),
}
# 3D：O 型网格 (中心方块 Nc×Nc + 四周 Nc×Nr)，轴向分段格数
GEOM3D = {
    'demo': dict(Nc=20, Nr=10, ny=[200, 30, 50]),
    'commercial': dict(Nc=24, Nr=12, ny=[160, 50, 60]),
    'pilot': dict(Nc=14, Nr=7, ny=[270, 50, 76, 16]),
}
SCALE, DEST = sys.argv[1], os.path.abspath(sys.argv[2])
NP = int(sys.argv[3]) if len(sys.argv) > 3 else 8
DIM3 = os.environ.get('DIM', '2') == '3'
CUSTOM = None
if SCALE == 'custom':
    # 放大设计 RSI：以商业装置为基准，按候选改直径/主反应区高度/床温/藏量/蒸汽比；进料 MeOH、新鲜剂量不变
    CUSTOM = json.load(open(os.environ['GEN_PARAMS']))
    b = CUSTOM.get('base', 'commercial'); R0b = GEOM[b]['secs'][0][1]; s_r = CUSTOM['D_m'] / 2 / R0b
    H0b = GEOM[b]['secs'][1][0]; dh = CUSTOM['H_m'] - H0b
    secs = [(0.0, R0b * s_r, 0)] + [(y + dh, r * s_r, n) for y, r, n in GEOM[b]['secs'][1:]]
    GEOM['custom'] = dict(NR=GEOM[b]['NR'], secs=secs)
    o = dict(OP[b]); o.update(T=CUSTOM['T_K'], inv=CUSTOM['inv_t'] * 1000., steam=o['meoh'] * CUSTOM['steam_ratio'])
    for k in ('end', 'avg'): 
        if k in CUSTOM: o[k] = CUSTOM[k] if k == 'end' else tuple(CUSTOM[k])
    OP['custom'] = o
G, O = GEOM[SCALE], OP[SCALE]
FIT = CUSTOM.get('base', 'commercial') if CUSTOM else SCALE
if DIM3: O = dict(O, end=float(os.environ.get('END3D', 40)), avg=(float(os.environ.get('AVG0', 20)), float(os.environ.get('END3D', 40))))


def kin(scale):
    """pilot: 738 K arr2 插值（与 pilot2D/pilot3D 相同）；demo: 763 K 表值（773 K 外推不能复现 Table 2，
    763 K 表值 + 773 K 气体状态方程能逐位复现 Table 2）；commercial: 748 K 表值（= arr2 端点）。"""
    if scale == 'custom': return C.interp(float(O['T']), 'arr2')
    if scale == 'pilot': return C.interp(738., 'arr2')
    if scale == 'demo': return C.k_tab[:, 2].copy(), C.a_tab[:, 2].copy()
    return C.k_tab[:, 1].copy(), C.a_tab[:, 1].copy()


K, A = kin(SCALE)
P_OUT = 101325. + O['pg'] * 1e6
R0 = G['secs'][0][1]; AREA = math.pi * R0 ** 2
DP_BED = O['inv'] * 9.81 / AREA
P_IN = P_OUT + DP_BED
n_mol = O['meoh'] / 32.042 + O['steam'] / 18.015          # kmol/h
U_IN = n_mol / 3.6 * 8.314 * O['T'] / P_IN / AREA         # m/s，进料按入口压力、床温
Y_MEOH = O['meoh'] / (O['meoh'] + O['steam'])
H0 = O['inv'] / (1500. * 0.55 * AREA)                     # 初始 0.55 堆积高度


def cstr():
    orig = C.interp
    C.interp = lambda Tb, mode: (K.copy(), A.copy())
    try:
        return C.solve(Tb=O['T'], mode='arr2', P=P_OUT, Is=O['inv'] * 1e3, Gs=O['gs'] * 1e3 / 3600, wc_in=O['wc_in'],
                       F_MeOH=O['meoh'] * 1e3 / 3600, F_H2O=O['steam'] * 1e3 / 3600)
    finally:
        C.interp = orig


CS = cstr()
WC0 = CS['wc']; Y_COKE0 = WC0 / (100. + WC0); Y_COKE_IN = O['wc_in'] / (100. + O['wc_in'])
KR = O['gs'] / O['inv'] / 3600.

if os.path.exists(DEST): sys.exit(f'{DEST} 已存在，不覆盖')
os.makedirs(DEST + '/system'); os.makedirs(DEST + '/constant'); os.makedirs(DEST + '/0.orig')
for f in ['system/fvSchemes', 'system/fvSolution', 'constant/g', 'constant/turbulenceProperties.gas',
          'constant/turbulenceProperties.particles', 'constant/thermophysicalProperties.particles']:
    shutil.copy(f'{TPL}/{f}', f'{DEST}/{f}')
W = lambda p, s: open(f'{DEST}/{p}', 'w').write(s)
# ---------- 物性：粘度按尺度 ----------
thg = open(f'{TPL}/constant/thermophysicalProperties.gas').read()
W('constant/thermophysicalProperties.gas', re.sub(r'mu 2\.43e-05', f'mu {O["mu"]:.4g}', thg))
# ---------- 曳力：EMMSscale ----------
pp = open(f'{TPL}/constant/phaseProperties').read()
pp = re.sub(r'type\s+GidaspowErgunWenYu;[^\n]*', f'type            EMMSscale;   // Lu2017 附录 {FIT} 拟合\n        fit             {FIT};\n        alphaMf         0.4;', pp)
pp = pp.replace('等温 738 K', f'等温 {O["T"]:.0f} K')
assert 'EMMSscale' in pp
W('constant/phaseProperties', pp)
# ---------- blockMesh ----------
secs, NR = G['secs'], G['NR']
th = math.radians(2.5); c, s = math.cos(th), math.sin(th)
V = []
for y, r, _ in secs: V += [(0, y, 0), (r * c, y, -r * s), (r * c, y, r * s)]
L = ["FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }", "scale 1;\nvertices\n("]
L += [f"    ({x:.15g} {y:.15g} {z:.15g})" for x, y, z in V]
L.append(");\nblocks\n(")
for i in range(1, len(secs)):
    a, b = 3 * (i - 1), 3 * i
    L.append(f"    hex ({a} {a+1} {b+1} {b} {a} {a+2} {b+2} {b}) ({NR} {secs[i][2]} 1) simpleGrading (1 1 1)")
L.append(");\nedges ();\nboundary\n(")
L.append("    inlet { type patch; faces ( (0 2 1 0) ); }")
n = 3 * (len(secs) - 1)
L.append(f"    outlet {{ type patch; faces ( ({n} {n+1} {n+2} {n}) ); }}")
L.append("    walls { type wall; faces ( " + " ".join(f"({3*(i-1)+1} {3*i+1} {3*i+2} {3*(i-1)+2})" for i in range(1, len(secs))) + " ); }")
L.append("    back { type wedge; faces ( " + " ".join(f"({3*(i-1)} {3*i} {3*i+1} {3*(i-1)+1})" for i in range(1, len(secs))) + " ); }")
L.append("    front { type wedge; faces ( " + " ".join(f"({3*(i-1)} {3*(i-1)+2} {3*i+2} {3*i})" for i in range(1, len(secs))) + " ); }")
L.append("    axis { type empty; faces ( " + " ".join(f"({3*(i-1)} {3*i} {3*i} {3*(i-1)})" for i in range(1, len(secs))) + " ); }")
L.append(");\nmergePatchPairs ();")
W('system/blockMeshDict', "\n".join(L) + "\n")
NCELL = NR * sum(x[2] for x in secs)
if DIM3:
    g3 = GEOM3D[SCALE]; Nc, Nr = g3['Nc'], g3['Nr']
    assert len(g3['ny']) == len(secs) - 1
    ang = [225, 135, 45, 315]; mid = [180, 90, 0, 270]
    V, E, B = [], [], []
    for y, r, _ in secs:
        sq = 0.4 * r
        for a in ang: V.append((math.copysign(sq, math.cos(math.radians(a))), y, math.copysign(sq, math.sin(math.radians(a)))))
        for a in ang: V.append((r * math.cos(math.radians(a)), y, r * math.sin(math.radians(a))))
    for k, (y, r, _) in enumerate(secs):
        b = 8 * k
        for j in range(4):
            E.append(f"    arc {b+4+j} {b+4+(j+1)%4} ({r*math.cos(math.radians(mid[j])):.12g} {y:.12g} {r*math.sin(math.radians(mid[j])):.12g})")
    inl, outl, wal = [], [], []
    for k in range(len(secs) - 1):
        b, t, ny = 8 * k, 8 * (k + 1), g3['ny'][k]
        i = lambda base, j: base + j % 4
        o = lambda base, j: base + 4 + j % 4
        B.append(f"    hex ({b} {b+1} {b+2} {b+3} {t} {t+1} {t+2} {t+3}) ({Nc} {Nc} {ny}) simpleGrading (1 1 1)")
        for j in range(4):
            B.append(f"    hex ({i(b,j+1)} {i(b,j)} {o(b,j)} {o(b,j+1)} {i(t,j+1)} {i(t,j)} {o(t,j)} {o(t,j+1)}) ({Nc} {Nr} {ny}) simpleGrading (1 1 1)")
            wal.append(f"({o(b,j)} {o(b,j+1)} {o(t,j+1)} {o(t,j)})")
    for base, lst in ((0, inl), (8 * (len(secs) - 1), outl)):
        lst.append(f"({base} {base+1} {base+2} {base+3})")
        for j in range(4): lst.append(f"({base + (j+1)%4} {base + j} {base+4+j} {base+4+(j+1)%4})")
    L = ["FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }", "scale 1;\nvertices\n("]
    L += [f"    ({x:.12g} {y:.12g} {z:.12g})" for x, y, z in V]
    L += [");\nblocks\n("] + B + [");\nedges\n("] + E + [");\nboundary\n("]
    L.append("    inlet { type patch; faces ( " + " ".join(inl) + " ); }")
    L.append("    outlet { type patch; faces ( " + " ".join(outl) + " ); }")
    L.append("    walls { type wall; faces ( " + " ".join(wal) + " ); }")
    L.append(");\nmergePatchPairs ();")
    W('system/blockMeshDict', "\n".join(L) + "\n")
    NCELL = (Nc * Nc + 4 * Nc * Nr) * sum(g3['ny'])
# ---------- 初始床层 ----------
W('system/setFieldsDict', f"""FoamFile {{ version 2.0; format ascii; class dictionary; object setFieldsDict; }}
defaultFieldValues ( volScalarFieldValue alpha.gas 1 volScalarFieldValue alpha.particles 0 );
regions
(
    boxToCell
    {{
        box ({-R0 - 1:.4f} 0 {-R0 - 1:.4f}) ({R0 + 1:.4f} {H0:.5f} {R0 + 1:.4f});
        fieldValues ( volScalarFieldValue alpha.gas 0.45 volScalarFieldValue alpha.particles 0.55 );
    }}
);
""")
W('system/decomposeParDict', f"FoamFile {{ version 2.0; format ascii; class dictionary; object decomposeParDict; }}\nnumberOfSubdomains {NP};\nmethod scotch;\n")
# ---------- 初值：CSTR 出口气相（含 MeOH/H2O） ----------
nM0, nW0 = O['meoh'] / 3600 / 32.042, O['steam'] / 3600 / 18.015       # kmol/s
r = np.array(CS['conv']) / 100 * nM0                                  # 消耗 MeOH kmol/s
lump_mass = np.array([CS['Y'][k] for k in ['CH4', 'C2H4', 'C3H6', 'C3H8', 'C4', 'C5']])
gas_hc = r * (32.042 - 18.015)                                         # 烃（含焦炭）质量 = CH2 质量；忽略焦炭份额
mM, mW = (nM0 - r) * 32.042, (nW0 + r) * 18.015
tot = mM + mW + gas_hc
Y0 = dict(MeOH=mM / tot, H2O=mW / tot)
for k, n in zip(['CH4', 'C2H4', 'C3H6', 'C3H8', 'C4H8', 'C5H10'], lump_mass): Y0[k] = gas_hc / tot * n
WEDGE = "" if DIM3 else "    back  { type wedge; }\n    front { type wedge; }\n    axis  { type empty; }"


def field(name, dim, internal, inlet, outlet, walls):
    cls = 'Vector' if '(' in str(internal) else 'Scalar'
    W(f'0.orig/{name}', f"""FoamFile {{ version 2.0; format ascii; class vol{cls}Field; object {name}; }}
dimensions {dim};
internalField uniform {internal};
boundaryField
{{
    inlet  {{ {inlet} }}
    outlet {{ {outlet} }}
    walls  {{ {walls} }}
{WEDGE}
}}
""")


D0, DU, DP, DT, DTh = '[0 0 0 0 0 0 0]', '[0 1 -1 0 0 0 0]', '[1 -1 -2 0 0 0 0]', '[0 0 0 1 0 0 0]', '[0 2 -2 0 0 0 0]'
zg, cal = 'type zeroGradient;', 'type calculated; value $internalField;'
T = O['T']
field('alpha.particles', D0, 0, zg, zg, zg)
field('alpha.gas', D0, 1, 'type fixedValue; value uniform 1;', 'type inletOutlet; phi phi.gas; inletValue uniform 1; value uniform 1;', zg)
field('U.gas', DU, f'(0 {U_IN:.6g} 0)', f'type interstitialInletVelocity; inletVelocity uniform (0 {U_IN:.6g} 0); alpha alpha.gas; value $internalField;',
      'type pressureInletOutletVelocity; phi phi.gas; value $internalField;', 'type noSlip;')
# 出口颗粒速度固定 0：颗粒不出计算域（相当于理想旋风返料，保持藏量恒定，DEV-S03）
field('U.particles', DU, '(0 0 0)', 'type fixedValue; value uniform (0 0 0);', 'type fixedValue; value uniform (0 0 0);', 'type noSlip;')
field('p', DP, P_OUT, cal, cal, cal)
field('p_rgh', DP, P_OUT, 'type fixedFluxPressure; value $internalField;', f'type prghPressure; p uniform {P_OUT}; value $internalField;',
      'type fixedFluxPressure; value $internalField;')
for ph in ['gas', 'particles']:
    field(f'T.{ph}', DT, T, f'type fixedValue; value uniform {T};', f'type inletOutlet; phi phi.{ph}; inletValue uniform {T}; value uniform {T};', zg)
field('Theta.particles', DTh, 1e-4, 'type fixedValue; value uniform 1e-4;', zg, zg)
field('nut.particles', '[0 2 -1 0 0 0 0]', 0, cal, cal, cal)
field('alphat.particles', '[1 -1 -1 0 0 0 0]', 0, cal, cal, cal)
field('alphat.gas', '[1 -1 -1 0 0 0 0]', 0, cal, cal, cal)
feed = dict(MeOH=Y_MEOH, H2O=1 - Y_MEOH)
for nme in ['MeOH', 'H2O', 'CH4', 'C2H4', 'C3H6', 'C3H8', 'C4H8', 'C5H10']:
    y0, yin = Y0[nme], feed.get(nme, 0.0)
    field(f'{nme}.gas', D0, f'{y0:.6g}', f'type fixedValue; value uniform {yin:.6g};',
          f'type inletOutlet; phi phi.gas; inletValue uniform {y0:.6g}; value uniform {y0:.6g};', zg)
field('Ydefault.gas', D0, 0, 'type fixedValue; value uniform 0;', 'type inletOutlet; phi phi.gas; inletValue uniform 0; value uniform 0;', zg)
field('coke.particles', D0, f'{Y_COKE0:.8g}', zg, zg, zg)
field('cat.particles', D0, f'{1 - Y_COKE0:.8g}', zg, zg, zg)
field('Ydefault.particles', D0, 0, zg, zg, zg)
# ---------- 动力学 fvOptions：替换模板里的 738 K 系数、新鲜剂更新率 ----------
fv = open(f'{TPL}/constant/fvOptions.reacting').read()
arr = lambda v: ', '.join(f'{x:.10g}' for x in v)
fv, n1 = re.subn(r'static const scalar k\[7\] = \{[^}]*\};', f'static const scalar k[7] = {{{arr(K)}}};', fv)
fv, n2 = re.subn(r'static const scalar a\[7\] = \{[^}]*\};', f'static const scalar a[7] = {{{arr(A)}}};', fv)
fv, n3 = re.subn(r'const scalar k7 = [0-9.eE+-]+, a7 = [0-9.eE+-]+,', f'const scalar k7 = {K[6]:.10g}, a7 = {A[6]:.10g},', fv)
fv, n4 = re.subn(r'const scalar kr = \(8\.8/9\.0\)/3600\.0, YcIn = 2\.0/102\.0;', f'const scalar kr = {KR:.10g}, YcIn = {Y_COKE_IN:.10g};', fv)
assert (n1, n2, n3, n4) == (1, 1, 1, 1), (n1, n2, n3, n4)
fv = fv.replace('738 K 系数来自 cstr/cstr_mto.py(arr2)', f'{SCALE} 系数见 gen_scale.py KIN（{O["T"]:.0f} K 床温）')
fv = fv.replace('// 738 K：Table 3 两点 Arrhenius(k) / 线性(α) 插值', f'// {SCALE}: k/α 见 deviations.log.md')
W('constant/fvOptions', fv)
# ---------- controlDict + 监测 ----------
t0, t1 = O['avg']
W('system/controlDict', f"""FoamFile {{ version 2.0; format ascii; class dictionary; object controlDict; }}
application     reactingTwoPhaseEulerFoam;
libs            ("libEMMSscaleDrag.so");
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         {O['end']:g};
deltaT          1e-4;
writeControl    adjustable;
writeInterval   5;
purgeWrite      0;
writeFormat     binary;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable on;
adjustTimeStep  yes;
maxCo           0.4;
maxDeltaT       {os.environ.get('MAXDT', '5e-4')};
functions
{{
    pInlet  {{ type surfaceFieldValue; libs (fieldFunctionObjects); regionType patch; name inlet; operation areaAverage; fields (p); writeFields false; writeControl timeStep; writeInterval 20; }}
    pOutlet {{ $pInlet; name outlet; }}
    bedInventory {{ type volFieldValue; libs (fieldFunctionObjects); operation volIntegrate; fields (alpha.particles); writeFields false; writeControl timeStep; writeInterval 20; }}
    outletSpecies
    {{
        type surfaceFieldValue; libs (fieldFunctionObjects); regionType patch; name outlet;
        operation weightedSum; weightField alphaRhoPhi.gas;
        fields (MeOH.gas H2O.gas CH4.gas C2H4.gas C3H6.gas C3H8.gas C4H8.gas C5H10.gas);
        writeFields false; writeControl timeStep; writeInterval 20;
    }}
    cokeMean {{ type volFieldValue; libs (fieldFunctionObjects); operation weightedVolAverage; weightField alpha.particles; fields (coke.particles); writeFields false; writeControl timeStep; writeInterval 20; }}
    alphaMean
    {{
        type fieldAverage; libs (fieldFunctionObjects); writeControl writeTime; restartOnRestart false; timeStart {t0:g};
        fields ( alpha.particles {{ mean on; prime2Mean off; base time; }} MeOH.gas {{ mean on; prime2Mean off; base time; }}
                 C2H4.gas {{ mean on; prime2Mean off; base time; }} C3H6.gas {{ mean on; prime2Mean off; base time; }} );
    }}
}}
""")
W('Allrun', f"""#!/bin/bash
cd "${{0%/*}}" || exit
source ~/OpenFOAM/OpenFOAM-v2306/etc/bashrc >/dev/null 2>&1 || true
rm -rf 0 && cp -r 0.orig 0
blockMesh > log.blockMesh 2>&1 && checkMesh > log.checkMesh 2>&1 && setFields > log.setFields 2>&1 || exit 1
decomposePar -force > log.decomposePar 2>&1 || exit 1
mpirun --bind-to none -np {NP} reactingTwoPhaseEulerFoam -parallel > log.reactingTwoPhaseEulerFoam 2>&1
""")
os.chmod(DEST + '/Allrun', 0o755)
meta = dict(scale=SCALE, cells=NCELL, np=NP, U_in=U_IN, P_out=P_OUT, P_in_est=P_IN, H0=H0, Y_MeOH_in=Y_MEOH,
            wc0=WC0, Y_coke0=Y_COKE0, Y_coke_in=Y_COKE_IN, kr=KR, k=K.tolist(), alpha=A.tolist(), cstr=CS, Y0=Y0,
            avg_window=O['avg'], end=O['end'], op=O, dim=3 if DIM3 else 2, sector=1 if DIM3 else 72)
json.dump(meta, open(DEST + '/case_meta.json', 'w'), indent=1, default=float)
DEV1 = (f"3D 全圆柱 O 型 blockMesh，{NCELL} 网格（原文 Gambit 混合网格，分布器附近加密）；本轮先算 {O['end']:g} s，统计 {O['avg'][0]:g}–{O['avg'][1]:g} s（原文 > 100 s）。\n"
        "  reason：算力；CSTR 初值使反应场很快稳定，流场 ~10–20 s 发展完。若半窗漂移超阈值再续算。") if DIM3 else \
       (f"2D 轴对称 wedge 5°，{NCELL} 网格。\n  reason：算力；与 pilot2D 同一口径，便于跨尺度比较。轴对称会让气泡/团聚偏向轴线。")
W('deviations.log.md', f"""# 偏离记录：{SCALE} 尺度（相对 Lu et al. 2017 CES 171:244）

[DEV-S01] 维度：原文 3D（{dict(pilot='34.6', demo='36.8', commercial='53.7')[FIT]} 万网格）→ {DEV1}
[DEV-S02] 几何：只建主反应区 + 过渡锥 + 稀相段（Fig.2 尺寸），不建汽提段/提升管/旋风/新鲜剂侧入口；
  分布器开孔（{dict(pilot='5 %', demo='2.2 %', commercial='3.8 % 多管')[FIT]}）→ 底部均匀进气。
[DEV-S03] 催化剂循环：以体积更新项 S = αsρs·(Gs/Is)·(Y_coke,in − Y_coke) 代替进出口（Gs/Is = {KR*3600:.4f} h⁻¹）；
  出口颗粒速度为 0，颗粒不出域（等效理想旋风返料，与原文 CFBC 模式"出口固体回注保持藏量"同义）。
[DEV-S04] 动力学：{ {'pilot': '738 K，Table 3 两点 Arrhenius/线性插值（同 pilot2D）', 'demo': '直接用 763 K 表值。773 K 外推（arr2）给出 CSTR C2H4/C3H6 = 2.12，而原文 Table 2 是 1.725；763 K 表值 + 773 K 气体状态方程逐位复现 Table 2（1.725 / wc 7.41），据此判断原文也用的 763 K 表值', 'commercial': '748 K 表值（Table 3 实测温度点，无插值）', 'custom': 'arr2 插值到 %.1f K（723–748 K 两点 Arrhenius / 线性）' % O['T']}[SCALE] }。
[DEV-S05] 新鲜剂焦炭 wc_in = {O['wc_in']} %：{ 'pilot2D 一致' if SCALE == 'pilot' else 'Table 2 只有 wc_in = 0 能复现（wc_in = 2 时 CSTR wc、转化率都偏离 Table 2）' }。
[DEV-S06] 曳力：EMMSscale fit={SCALE}（附录 Table {dict(pilot='A2', demo='A3', commercial='A4')[FIT]} 原式），H_D 截断到 [1e-4, 1]；
  { 'A4 第 4 段在 εg→0.9997 处 ln εg→0 发散为负值，截断后取 1e-4…1，影响仅限极稀相。' if SCALE == 'commercial' else '无截断生效（拟合值在 0.06–1 之间）。' }
[DEV-S07] 气体粘度 {O['mu']:.4g} Pa·s（附录表头），各组分同值；恢复系数 e = 0.9（原文未给，同 pilot2D DEV-005）。
[DEV-S08] 初值：床层 0.55 堆积到 H0 = {H0:.3f} m（藏量 {O['inv']:g} kg），焦炭与气相组分取 CSTR 稳态（原文做法）。
""")
print(json.dumps(dict(scale=SCALE, dest=DEST, cells=NCELL, U_in=round(U_IN, 4), P_out=P_OUT, H0=round(H0, 3),
                      wc0=round(WC0, 3), ratio_cstr=round(CS['ratio'], 4), conv_cstr=round(CS['conv'], 3)), ensure_ascii=False))
