"""通用 RSI 核心：study（插件接口）、archive（存档与判据）、scheduler（并行 + 分级）、propose、loop。"""
import importlib.util, os

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIES = os.path.join(os.path.dirname(HERE), 'studies')


def load_study(name, **kw):
    """rsi/studies/<name>/plugin.py 的 make(**kw)"""
    path = os.path.join(STUDIES, name, 'plugin.py')
    spec = importlib.util.spec_from_file_location(f'rsi_study_{name}', path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod.make(**kw)
