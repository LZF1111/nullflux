"""
params.example.py — LBM 参数与单位换算配置示例。
把物理工况填在上半，运行得到格子参数 (tau/omega)，再喂给求解器。
"""

# ---------- 物理工况 (SI) ----------
L_phys   = 0.1        # 特征长度 [m]
U_phys   = 1.0        # 特征速度 [m/s]
nu_phys  = 1.0e-4     # 运动黏度 [m^2/s]   -> Re = U*L/nu
Re = U_phys * L_phys / nu_phys

# ---------- 分辨率与格子速度 ----------
N      = 128          # 特征长度方向格子数 (L_lb = N)
u_lb   = 0.1          # 顶盖/特征 格子速度 (< 0.1)

# ---------- 反推格子参数 ----------
L_lb   = N
nu_lb  = u_lb * L_lb / Re
tau    = 3.0 * nu_lb + 0.5
omega  = 1.0 / tau

# ---------- 换算因子 (格子↔物理) ----------
dx = L_phys / L_lb            # 长度: 1 lu = dx m
dt = u_lb / U_phys * dx       # 时间: 由 u_lb = U_phys * dt/dx
# 压力/力换算: p_phys = p_lb * rho_phys * (dx/dt)^2, 等

if __name__ == "__main__":
    assert tau > 0.5, f"tau={tau} <= 0.5 失稳: 减小 u_lb 或加 N"
    print(f"Re={Re:.1f}  N={N}  u_lb={u_lb}")
    print(f"nu_lb={nu_lb:.6f}  tau={tau:.4f}  omega={omega:.4f}")
    print(f"dx={dx:.3e} m/lu   dt={dt:.3e} s/ts")
