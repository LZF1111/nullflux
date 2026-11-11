"""研究插件接口。核心（存档、调度、分级筛选、接受判据、提议）只通过这个接口和具体研究打交道。
一个研究 = 一个目录 rsi/studies/<name>/plugin.py，里面 make(**kw) 返回 Study 子类实例。
目标量一律"越小越好"；最大化问题在插件里取负号。"""
import math


class Fidelity:
    """一个保真度级别：name 唯一；params 覆盖 trial-params（如更短的续算时长）；full 级别只能有一个且排在最后。"""
    def __init__(self, name, params=None, np=None, full=False):
        self.name, self.params, self.np, self.full = name, dict(params or {}), np, full

    def __repr__(self): return f'Fidelity({self.name!r}, full={self.full})'


class Study:
    name = 'study'                 # 存档里的 study 字段
    work_root = None               # 存档、试验目录、配置都在这里
    base_case = None               # cfd_trial baseCase（只读模板）
    cfd_trial = None               # cfd_trial.js 路径
    np = 1                         # 每个完整试验的核数
    reserve_cores = 0              # 给别的作业留的核
    sealed = ()                    # 封存量：提议者看不到，不进接受判据
    accept_min_gain = 0.0
    accept_kappa = 2.0
    task = ''                      # 给 LLM 提议者的任务说明
    code_suffix = '.py'            # LLM 候选文件后缀
    screen_margin = 0.0            # 分级筛选：短算目标比参考差不超过它（再加噪声项）就晋级
    screen_kappa = 1.0
    control_path = None            # 对照候选文件

    # ---- 保真度 ----
    def fidelities(self):
        """从低到高；最后一个是 full。只有一个 full 时等价于不分级。"""
        return [Fidelity('full', full=True)]

    # ---- 候选 ----
    def check(self, path):
        """离线检查候选：dict(ok, violations, hash, path, cell, features, ...)。不能跑 CFD。"""
        raise NotImplementedError

    def surrogate(self, rec, arch):
        """廉价代理（越小越好），只用于排序；没有就返回 0。"""
        return 0.0

    def calibrate(self, done, arch):
        """用已完成的完整试验回标代理，返回新的 arch['surrogate']，不改就返回 None。"""
        return None

    def default_surrogate(self): return {}

    # ---- 试验 ----
    def trial_params(self, chk, fidelity, control):
        raise NotImplementedError

    def pipeline(self, fidelity):
        """dict(stages=..., acceptance=...)，直接交给 cfd_trial.js。"""
        raise NotImplementedError

    def fidelity_np(self, fidelity): return fidelity.np or self.np

    # ---- 判据 ----
    def objective(self, metrics):
        raise NotImplementedError

    def noise(self, metrics):
        """目标量的统计噪声（同一单位）；没有估计时返回 0。"""
        return 0.0

    def control_check(self, metrics, valid):
        """对照是否复现基准：(ok, diff)。"""
        return bool(valid), 0.0

    # ---- 提议者上下文 ----
    def context_text(self, arch):
        return ''

    def propose_builtin(self, arch, n, out_dir):
        """不用 LLM 的内置提议者（如参数研究的采样器），返回候选文件路径列表；不支持就返回 None。"""
        return None


def finite(v):
    try: return math.isfinite(float(v))
    except (TypeError, ValueError): return False
