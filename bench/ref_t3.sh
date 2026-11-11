#!/bin/bash
# T3 判定可行性校准：从官方教程改造一个参考算例，确认 Δp 理论区间可达。只给判定用，不给任何一方看。
source /home/user/OpenFOAM/OpenFOAM-v2306/etc/bashrc >/dev/null 2>&1
NP=${NP:-8}
R=$HOME/bench/ref_t3; rm -rf $R; mkdir -p $R; cd $R
cp -r $FOAM_TUTORIALS/multiphase/twoPhaseEulerFoam/laminar/fluidisedBed case; cd case
cp -r 0.orig 0
# 几何 0.3 × 1.0，网格 60 × 200
sed -i 's/(0.15 0 -0.01)/(0.3 0 -0.01)/; s/(0.15 1 -0.01)/(0.3 1 -0.01)/; s/(0.15 0 0.01)/(0.3 0 0.01)/; s/(0.15 1 0.01)/(0.3 1 0.01)/; s/(30 200 1)/(60 200 1)/' system/blockMeshDict
sed -i 's/box (0 0 -0.1) (0.15 0.5 0.1);/box (0 0 -0.1) (0.3 0.4 0.1);/' system/setFieldsDict
sed -i 's/inletVelocity      uniform (0 0.25 0);/inletVelocity      uniform (0 0.3 0);/' 0/U.air
sed -i 's/^endTime .*/endTime         6;/; s/^writeInterval .*/writeInterval   1;/' system/controlDict
python3 - <<'EOF'
s = open('system/controlDict').read()
fo = '''
    pIn  { type surfaceFieldValue; libs (fieldFunctionObjects); regionType patch; name inlet;  operation areaAverage; fields (p); writeFields false; log false; writeControl timeStep; writeInterval 20; }
    pOut { type surfaceFieldValue; libs (fieldFunctionObjects); regionType patch; name outlet; operation areaAverage; fields (p); writeFields false; log false; writeControl timeStep; writeInterval 20; }
'''
i = s.index('functions'); j = s.index('{', i) + 1
open('system/controlDict', 'w').write(s[:j] + fo + s[j:])
EOF
cat > system/decomposeParDict <<EOF
FoamFile { version 2.0; format ascii; class dictionary; object decomposeParDict; }
numberOfSubdomains $NP; method scotch;
EOF
blockMesh > log.blockMesh 2>&1 && setFields > log.setFields 2>&1 && decomposePar > log.decomposePar 2>&1 || { echo prep failed; tail log.*; exit 1; }
T0=$(date +%s)
mpirun -np $NP twoPhaseEulerFoam -parallel > log.twoPhaseEulerFoam 2>&1
echo "solve wall $(( $(date +%s) - T0 )) s"
tail -3 log.twoPhaseEulerFoam
python3 $HOME/bench/judge_t3.py $R
