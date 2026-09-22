"""Reproduce the driver's focus refusal outside the app: background python, foreign foreground.
Local diagnostic; touches only fixtures we launch. Prints the exact focus_window_checked dict."""
import json, os, subprocess, sys, tempfile, time, ctypes
from pathlib import Path
import self_connect as sc

u = ctypes.windll.user32
fixture = str(Path(__file__).with_name('computer-use-fixture.py'))
work = tempfile.mkdtemp(prefix='sct-focus-')

def launch(name):
    before = {w.hwnd for w in sc.list_windows()} if hasattr(sc, 'list_windows') else set()
    p = subprocess.Popen([sys.executable, fixture, os.path.join(work, name + '.json')])
    win = None
    for _ in range(60):
        time.sleep(0.25)
        for w in sc.list_windows():
            if w.hwnd not in before and w.pid == p.pid and 'SCT Desktop Acceptance Fixture' in (w.title or ''):
                win = w; break
        if win: break
    return p, win

out = {'steps': []}
pt, target = launch('target')
ps, sink = launch('sink')
out['target'] = target.hwnd if target else None
out['sink'] = sink.hwnd if sink else None
try:
    # Case A: sink is foreground (foreign), we are a background process -> focus target
    r = sc.focus_window_checked(sink.hwnd)
    out['steps'].append({'case': 'focus_sink_first', 'result': r, 'fg_after': int(u.GetForegroundWindow())})
    time.sleep(0.5)
    r = sc.focus_window_checked(target.hwnd)
    out['steps'].append({'case': 'A_foreign_fg_then_focus_target', 'result': r, 'fg_after': int(u.GetForegroundWindow())})
    time.sleep(0.5)
    # Case B: target already foreground
    r = sc.focus_window_checked(target.hwnd)
    out['steps'].append({'case': 'B_target_already_fg', 'result': r, 'fg_after': int(u.GetForegroundWindow())})
    # Case C: from a CHILD process (like the MCP driver spawned by the app), sink foreground first
    sc.focus_window_checked(sink.hwnd); time.sleep(0.5)
    child = subprocess.run([sys.executable, '-c',
        "import sys,json,ctypes;import self_connect as sc;"
        f"r=sc.focus_window_checked({target.hwnd});print(json.dumps({{'result':r,'fg_after':int(ctypes.windll.user32.GetForegroundWindow())}}))"],
        capture_output=True, text=True, timeout=30)
    out['steps'].append({'case': 'C_child_process_focus_target', 'stdout': child.stdout.strip()[:1500], 'stderr': child.stderr.strip()[-500:]})
finally:
    for p in (pt, ps):
        try: p.kill()
        except Exception: pass
print(json.dumps(out, indent=1, default=str))
