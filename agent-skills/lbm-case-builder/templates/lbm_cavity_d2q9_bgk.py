"""
lbm_cavity_d2q9_bgk.py — 顶盖驱动方腔 (Lid-driven cavity), D2Q9 + BGK, 半程 bounce-back。
完整可运行示例 (仅依赖 numpy)。稳态残差收敛后输出速度场 .npy。
参照官方: Palabos examples/showCases/cavity2d; Krüger et al. 教材公式。

单位换算: 内部全格子单位 (dx=dt=1, cs2=1/3)。给定 Re 与顶盖格子速度 u_lid 反推 tau。
"""
import numpy as np

# ---------------- 参数 (物理→格子换算写在这) ----------------
Nx, Ny = 128, 128          # 格子数
Re     = 1000.0            # 雷诺数 (特征长度 = Ny-1)
u_lid  = 0.1               # 顶盖格子速度 (< 0.1, 越小越准)
max_steps = 200000
tol       = 1e-7           # 稳态相对速度残差
check_every = 500

L   = Ny - 1
nu  = u_lid * L / Re       # 格子运动黏度
tau = 3.0 * nu + 0.5       # BGK 松弛时间, 必须 > 0.5
omega = 1.0 / tau
assert tau > 0.5, f"tau={tau} <= 0.5, 失稳: 减小 u_lid 或加分辨率"
print(f"[params] nu_lb={nu:.6f} tau={tau:.4f} omega={omega:.4f}")

# ---------------- D2Q9 格子常数 ----------------
# 索引顺序: 0静止, 1-4 轴向, 5-8 对角
c = np.array([[0,0],[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]], dtype=np.int32)
w = np.array([4/9, 1/9,1/9,1/9,1/9, 1/36,1/36,1/36,1/36])
opp = np.array([0, 3,4,1,2, 7,8,5,6])   # 反向索引 (bounce-back)
Q = 9
cs2 = 1.0/3.0

# ---------------- 场 (SoA: f[Q, Nx, Ny]) ----------------
rho = np.ones((Nx, Ny))
ux  = np.zeros((Nx, Ny))
uy  = np.zeros((Nx, Ny))

def equilibrium(rho, ux, uy):
    feq = np.empty((Q, Nx, Ny))
    usqr = ux*ux + uy*uy
    for i in range(Q):
        cu = c[i,0]*ux + c[i,1]*uy
        feq[i] = w[i] * rho * (1 + 3*cu + 4.5*cu*cu - 1.5*usqr)
    return feq

f = equilibrium(rho, ux, uy)

# 顶盖 (y = Ny-1) 施加水平速度 u_lid; 其余三壁静止无滑移。
def macros(f):
    rho = f.sum(axis=0)
    ux  = (c[:,0][:,None,None]*f).sum(axis=0) / rho
    uy  = (c[:,1][:,None,None]*f).sum(axis=0) / rho
    return rho, ux, uy

# ---------------- 主循环 ----------------
u_prev = np.zeros((Nx, Ny))
for step in range(max_steps):
    rho, ux, uy = macros(f)

    # collision (BGK)
    feq = equilibrium(rho, ux, uy)
    fstar = f - omega * (f - feq)

    # streaming (push, 周期 roll; 边界随后用 bounce-back 覆盖)
    for i in range(Q):
        f[i] = np.roll(np.roll(fstar[i], c[i,0], axis=0), c[i,1], axis=1)

    # --- 半程 bounce-back 固壁: 左/右/底 三壁静止 ---
    # 左壁 x=0: 反弹指向域内(+x)分量
    for i in [1,5,8]:
        f[i,0,:] = fstar[opp[i],0,:]
    # 右壁 x=Nx-1: 反弹(-x)
    for i in [3,6,7]:
        f[i,-1,:] = fstar[opp[i],-1,:]
    # 底壁 y=0: 反弹(+y)
    for i in [2,5,6]:
        f[i,:,0] = fstar[opp[i],:,0]
    # --- 顶盖 y=Ny-1: 运动壁 bounce-back (动量修正) ---
    for i in [4,7,8]:
        f[i,:,-1] = fstar[opp[i],:,-1] - 2*w[i]*rho[:,-1]*(c[i,0]*u_lid)/cs2

    # 收敛判据
    if step % check_every == 0 and step > 0:
        rho, ux, uy = macros(f)
        umag = np.sqrt(ux*ux + uy*uy)
        res = np.linalg.norm(umag - u_prev) / (np.linalg.norm(umag) + 1e-30)
        u_prev = umag.copy()
        print(f"step {step:6d}  residual {res:.3e}")
        if not np.isfinite(res):
            raise FloatingPointError("发散(NaN): 减小 u_lid 或加分辨率/换 MRT")
        if res < tol:
            print(f"[converged] step={step} res={res:.3e}")
            break

rho, ux, uy = macros(f)
np.save("cavity_ux.npy", ux)
np.save("cavity_uy.npy", uy)
print(f"[done] saved cavity_ux.npy / cavity_uy.npy  (max|u|={np.sqrt(ux*ux+uy*uy).max():.4f})")
