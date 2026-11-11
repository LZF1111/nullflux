#!/usr/bin/env python3
"""Regenerate case_template/ for twoPhaseEulerFoam v2306.

Derived from $FOAM_TUTORIALS/multiphase/twoPhaseEulerFoam/RAS/bubbleColumn
(same solver settings, thermo, drag, mixtureKEpsilon), changed to:
  - quasi-2D column W x H_dom x D, liquid filled to H_liq by setFields
  - three bottom inlet patches; U.air / alpha.air per zone from tableFile
    (constant/zoneN_U.dat, constant/zoneN_alpha.dat, written by stage_generate.py)
  - air-water at 300 K
Run:  python make_template.py
"""
import json, os, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
C = json.load(open(os.path.join(HERE, 'contract.json'), encoding='utf-8'))
G = C['geometry']
NZ = int(os.environ.get('BC_NZ', '1'))
NZONES = int(os.environ.get('BC_NZONES', '3'))
OUT = os.path.join(HERE, 'case_template' + ('' if NZ == 1 else f'_3d{NZ}') + ('' if NZONES == 3 else f'_z{NZONES}'))

W, D = G['W_m'], G['D_m']
H_LIQ, H_DOM = G['H_liq_m'], G['H_dom_m']
DX = G['cell_m']
NXZ = int(round(W / DX / NZONES))
assert abs(NXZ * NZONES * DX - W) < 1e-9, 'zone count must divide the cell count'
E = [round(-W / 2 + k * W / NZONES, 6) for k in range(NZONES + 1)]
NY = int(round(H_DOM / DX))
ALPHA_IN = C['physics']['alpha_inlet']
UG = C['zones']['Ug_total_ms']
ZONES = [f'zone{i + 1}_inlet' for i in range(NZONES)]

HDR = 'FoamFile\n{{\n    version     2.0;\n    format      ascii;\n    class       {cls};\n    object      {obj};\n}}\n\n'


def w(rel, cls, body):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='\n') as f:
        f.write(HDR.format(cls=cls, obj=os.path.basename(rel)) + body)


def bc(**kv):
    return ''.join(f'        {k:<20}{v};\n' for k, v in kv.items())


def table_bc(i, kind, default):
    return ('        type         uniformFixedValue;\n'
     '        uniformValue\n {\n'
            '     type        tableFile;\n'
     f'     file "<constant>/zone{i + 1}_{kind}.dat";\n'
     '     outOfBounds clamp;\n'
     '        }\n'
     f'        value        {default};\n')


def field(rel, cls, dims, internal, inlet, outlet, walls, per_zone=None):
    parts = [f'dimensions      {dims};\n\ninternalField   {internal};\n\nboundaryField\n{{']
    for i, z in enumerate(ZONES):
        parts.append(f'    {z}\n    {{\n{per_zone(i) if per_zone else inlet}    }}')
    parts.append(f'    outlet\n    {{\n{outlet}    }}')
    parts.append(f'    walls\n    {{\n{walls}    }}')
    parts.append('    frontAndBack\n    {\n        type         empty;\n    }\n}\n' if NZ == 1 else '}\n')
    w(rel, cls, '\n'.join(parts))


def write_system():
    verts = []
    for zc in (0.0, D):
        for y in (0.0, H_DOM):
            for x in E:
                verts.append((x, y, zc))

    def vid(xi, yi, zi):
        return zi * 2 * (NZONES + 1) + yi * (NZONES + 1) + xi

    vtxt = '\n'.join(f'    ({x:g} {y:g} {z:g})  // {k}' for k, (x, y, z) in enumerate(verts))
    blocks, inl, top, side, fb = [], [], [], [], []
    for b in range(NZONES):
        p = [vid(b, 0, 0), vid(b + 1, 0, 0), vid(b + 1, 1, 0), vid(b, 1, 0),
                    vid(b, 0, 1), vid(b + 1, 0, 1), vid(b + 1, 1, 1), vid(b, 1, 1)]
        blocks.append(f'    hex ({" ".join(map(str, p))}) ({NXZ} {NY} {NZ}) simpleGrading (1 1 1)')
        inl.append(f'({p[0]} {p[1]} {p[5]} {p[4]})')
        top.append(f'({p[3]} {p[7]} {p[6]} {p[2]})')
        fb += [f'({p[0]} {p[3]} {p[2]} {p[1]})', f'({p[4]} {p[5]} {p[6]} {p[7]})']
        if b == 0:
            side.append(f'({p[0]} {p[4]} {p[7]} {p[3]})')
        if b == NZONES - 1:
            side.append(f'({p[1]} {p[2]} {p[6]} {p[5]})')
    if NZ > 1:   # 3D: front/back plates are no-slip walls
        side, fb = side + fb, []
    bnd = [f'    {ZONES[i]}\n    {{\n        type patch;\n        faces ({f});\n    }}' for i, f in enumerate(inl)]
    bnd.append(f'    outlet\n    {{\n type patch;\n faces ({" ".join(top)});\n    }}')
    bnd.append(f'    walls\n    {{\n        type wall;\n        faces ({" ".join(side)});\n    }}')
    if NZ == 1:
        bnd.append(f'    frontAndBack\n    {{\n        type empty;\n        faces ({" ".join(fb)});\n    }}')
    w('system/blockMeshDict', 'dictionary',
                    f'scale 1;\n\n// {NZONES * NXZ} x {NY} x {NZ} cells, {DX * 1e3:g} mm; block order = zone order (left, centre, right)\n'
                    f'vertices\n(\n{vtxt}\n);\n\nblocks\n(\n' + '\n'.join(blocks) +
                    '\n);\n\nedges ();\n\nboundary\n(\n' + '\n'.join(bnd) + '\n);\n\nmergePatchPairs ();\n')

    w('system/controlDict', 'dictionary', '''application     twoPhaseEulerFoam;
startFrom       latestTime;
startTime0;
stopAt          endTime;
endTime         15;  // stage_solve.sh sets settle / tracking end times
deltaT   0.001;
writeControl    adjustable;
writeInterval   15;  // stage_solve.sh sets the tracking-window interval
purgeWrite      0;
writeFormat     ascii;
writePrecision  7;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable yes;
adjustTimeStep  yes;
maxCo           0.4;
maxDeltaT       0.005;
''')

    w('system/fvSchemes', 'dictionary', r'''ddtSchemes      { default Euler; }
gradSchemes     { default Gauss linear; }
divSchemes
{
    default    none;
    div(phi,alpha.air)       Gauss vanLeer;
    div(phir,alpha.air)      Gauss vanLeer;
    "div\(alphaRhoPhi.*,U.*\)"      Gauss limitedLinearV 1;
    "div\(phi.*,U.*\)"       Gauss limitedLinearV 1;
    "div\(alphaRhoPhi.*,(h|e).*\)"  Gauss limitedLinear 1;
    "div\(alphaRhoPhi.*,K.*\)"      Gauss limitedLinear 1;
    "div\(alphaPhi.*,p\)"    Gauss limitedLinear 1;
    "div\(alphaRhoPhi.*,(k|epsilon).*\)"  Gauss limitedLinear 1;
    "div\(phim,(k|epsilon)m\)"      Gauss limitedLinear 1;
    "div\(\(\(\(alpha.*\*thermo:rho.*\)\*nuEff.*\)\*dev2\(T\(grad\(U.*\)\)\)\)\)" Gauss linear;
}
laplacianSchemes     { default Gauss linear uncorrected; }
interpolationSchemes { default linear; }
snGradSchemes        { default uncorrected; }
''')

    w('system/fvSolution', 'dictionary', '''solvers
{
    alpha.air
    {
        nAlphaCorr      1;
        nAlphaSubCycles 2;
    }
    p_rgh
    {
        solver          GAMG;
        smoother DIC;
        tolerance       1e-8;
        relTol          0;
    }
    p_rghFinal
    {
        $p_rgh;
        relTol   0;
    }
    "(U|e|k|epsilon|Theta).*"
    {
        solver   smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-7;
        relTol   0;
        minIter  1;
    }
}
PIMPLE
{
    nOuterCorrectors 3;
    nCorrectors      1;
    nNonOrthogonalCorrectors 0;
}
relaxationFactors { equations { ".*" 1; } }
''')

    w('system/setFieldsDict', 'dictionary', f'''defaultFieldValues ( volScalarFieldValue alpha.air 1 );
regions
(
    boxToCell
    {{
        box ({-W:g} -1 -1) ({W:g} {H_LIQ:g} 1);
        fieldValues ( volScalarFieldValue alpha.air 0 );
    }}
);
''')
    w('system/decomposeParDict', 'dictionary', 'numberOfSubdomains 1;\nmethod   scotch;\n')


def write_constant():
    w('constant/g', 'uniformDimensionedVectorField', 'dimensions      [0 1 -2 0 0 0 0];\nvalue    (0 -9.81 0);\n')
    w('constant/phaseProperties', 'dictionary', f'''phases          (air water);

air
{{
    diameterModel   isothermal;
    isothermalCoeffs
    {{
        d0       {C['physics']['db_m']:g};
        p0       1e5;
    }}
    residualAlpha   1e-6;
}}

water
{{
    diameterModel   constant;
    constantCoeffs  {{ d 1e-4; }}
    residualAlpha   1e-6;
}}

blending
{{
    default
    {{
        type     linear;
        maxFullyDispersedAlpha.air 0.3;
        maxPartlyDispersedAlpha.air 0.5;
        maxFullyDispersedAlpha.water 0.3;
        maxPartlyDispersedAlpha.water 0.5;
    }}
}}

sigma    ( (air and water) 0.072 );

aspectRatio
(
    (air in water) {{ type constant; E0 1.0; }}
    (water in air) {{ type constant; E0 1.0; }}
);

drag
(
    (air in water)  {{ type SchillerNaumann; residualRe 1e-3; swarmCorrection {{ type none; }} }}
    (water in air)  {{ type SchillerNaumann; residualRe 1e-3; swarmCorrection {{ type none; }} }}
    (air and water) {{ type segregated; m 0.5; n 8; swarmCorrection {{ type none; }} }}
);

virtualMass
(
    (air in water) {{ type constantCoefficient; Cvm 0.5; }}
    (water in air) {{ type constantCoefficient; Cvm 0.5; }}
);

heatTransfer
(
    (air in water) {{ type RanzMarshall; residualAlpha 1e-4; }}
    (water in air) {{ type RanzMarshall; residualAlpha 1e-4; }}
);

lift            ();
wallLubrication ();
turbulentDispersion ();

pMin     10000;
''')
    w('constant/thermophysicalProperties.air', 'dictionary', '''thermoType
{
    type            heRhoThermo;
    mixture         pureMixture;
    transport       const;
    thermo          hConst;
    equationOfState perfectGas;
    specie   specie;
    energy          sensibleInternalEnergy;
}
mixture
{
    specie   { molWeight 28.9; }
    thermodynamics  { Cp 1007; Hf 0; }
    transport       { mu 1.84e-05; Pr 0.7; }
}
''')
    w('constant/thermophysicalProperties.water', 'dictionary', '''thermoType
{
    type     heRhoThermo;
    mixture  pureMixture;
    transport       const;
    thermo          eConst;
    equationOfState perfectFluid;
    specie   specie;
    energy   sensibleInternalEnergy;
}
mixture
{
    specie          { molWeight 18; }
    equationOfState { R 3000; rho0 998.2; }
    thermodynamics  { Cv 4195; Hf 0; }
    transport       { mu 1.0e-3; Pr 7.0; }
}
''')
    for ph in ('air', 'water'):
        w(f'constant/turbulenceProperties.{ph}', 'dictionary',
   'simulationType  RAS;\nRAS\n{\n    RASModel mixtureKEpsilon;\n    turbulence      on;\n    printCoeffs     on;\n}\n')
    for i in range(NZONES):
        for kind, val in (('U', f'(0 {UG / ALPHA_IN:g} 0)'), ('alpha', f'{ALPHA_IN:g}')):
            with open(os.path.join(OUT, 'constant', f'zone{i + 1}_{kind}.dat'), 'w', newline='\n') as f:
                f.write(f'(\n    (0 {val})\n    (1000 {val})\n)\n')


def write_zero():
    S, V = 'volScalarField', 'volVectorField'
    keep = '$internalField'
    field('0/alpha.air', S, '[0 0 0 0 0 0 0]', 'uniform 0', None,
          bc(type='inletOutlet', phi='phi.air', inletValue='uniform 1', value='uniform 1'),
   bc(type='zeroGradient'), per_zone=lambda i: table_bc(i, 'alpha', f'uniform {ALPHA_IN:g}'))
    field('0/U.air', V, '[0 1 -1 0 0 0 0]', 'uniform (0 0 0)', None,
          bc(type='pressureInletOutletVelocity', phi='phi.air', value='uniform (0 0 0)'),
          bc(type='fixedValue', value='uniform (0 0 0)'),
   per_zone=lambda i: table_bc(i, 'U', f'uniform (0 {UG / ALPHA_IN:g} 0)'))
    field('0/U.water', V, '[0 1 -1 0 0 0 0]', 'uniform (0 0 0)',
   bc(type='fixedValue', value='uniform (0 0 0)'),
          bc(type='pressureInletOutletVelocity', phi='phi.water', value='uniform (0 0 0)'),
   bc(type='fixedValue', value='uniform (0 0 0)'))
    field('0/p', S, '[1 -1 -2 0 0 0 0]', 'uniform 1e5',
          bc(type='calculated', value=keep), bc(type='calculated', value=keep), bc(type='calculated', value=keep))
    field('0/p_rgh', S, '[1 -1 -2 0 0 0 0]', 'uniform 1e5',
   bc(type='fixedFluxPressure', value=keep),
          bc(type='prghPressure', p=keep, value=keep),
          bc(type='fixedFluxPressure', value=keep))
    for ph in ('air', 'water'):
        io = bc(type='inletOutlet', phi=f'phi.{ph}', inletValue=keep, value=keep)
        field(f'0/T.{ph}', S, '[0 0 0 1 0 0 0]', 'uniform 300', bc(type='fixedValue', value=keep), io,
       bc(type='zeroGradient'))
        field(f'0/k.{ph}', S, '[0 2 -2 0 0 0 0]', 'uniform 3.75e-5', bc(type='fixedValue', value=keep), io,
       bc(type='kqRWallFunction', value=keep))
        field(f'0/epsilon.{ph}', S, '[0 2 -3 0 0 0 0]', 'uniform 1.5e-4', bc(type='fixedValue', value=keep), io,
       bc(type='epsilonWallFunction', value=keep))
        field(f'0/nut.{ph}', S, '[0 2 -1 0 0 0 0]', 'uniform 1e-8', bc(type='calculated', value=keep),
       bc(type='calculated', value=keep), bc(type='nutkWallFunction', value=keep))
        field(f'0/alphat.{ph}', S, '[1 -1 -1 0 0 0 0]', 'uniform 0', bc(type='calculated', value=keep),
       bc(type='calculated', value=keep),
bc(type='compressible::alphatWallFunction', Prt='0.85', value=keep))
    iom = bc(type='inletOutlet', phi='phim', inletValue=keep, value=keep)
    field('0/km', S, '[0 2 -2 0 0 0 0]', 'uniform 3.75e-5', bc(type='fixedValue', value=keep), iom,
          bc(type='zeroGradient'))
    field('0/epsilonm', S, '[0 2 -3 0 0 0 0]', 'uniform 1.5e-4', bc(type='fixedValue', value=keep), iom,
          bc(type='zeroGradient'))
    field('0/Theta', S, '[0 2 -2 0 0 0 0]', 'uniform 0', bc(type='fixedValue', value='uniform 1e-7'),
          bc(type='inletOutlet', inletValue='uniform 1e-7', value='uniform 1e-7'), bc(type='zeroGradient'))


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    write_system()
    write_constant()
    write_zero()
    json.dump(dict(n=NZONES, edges=E), open(os.path.join(OUT, 'zones.json'), 'w'))
    n = sum(len(fs) for _, _, fs in os.walk(OUT))
    print(f'case_template: {n} files, mesh {NZONES * NXZ} x {NY} x {NZ}, {NZONES} zones')


if __name__ == '__main__':
    main()
