"""Exercise the installed driver's parent-death interlock without desktop input."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

driver = str(Path(sys.argv[1]).resolve())
work = Path(tempfile.mkdtemp(prefix='sct-parent-interlock-'))
child = work / 'child.py'
child.write_text('''import importlib.util,json,os,time
from pathlib import Path
root=Path(os.environ['PROBE_ROOT'])
spec=importlib.util.spec_from_file_location('desktop_driver',os.environ['PROBE_DRIVER'])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
(root/'ready').write_text(str(os.getpid()))
while not (root/'check').exists():time.sleep(.05)
try:
 m.guard({'hwnd':0,'pid':0,'exe':'none','className':'none','title':'none'})
 result={'outcome':'Failed','reason':'guard allowed dead parent'}
except Exception as e:
 reason=str(e);result={'outcome':'Worked' if reason=='STOPPED: controlling process exited' else 'Failed','reason':reason}
(root/'result.json').write_text(json.dumps(result))
''')
env = {**os.environ, 'PROBE_ROOT': str(work), 'PROBE_DRIVER': driver, 'SCT_COMPUTER_EVIDENCE': str(work/'evidence')}
parent_code = "import subprocess,sys,time;subprocess.Popen([sys.executable,sys.argv[1]]);time.sleep(30)"
parent = subprocess.Popen([sys.executable, '-c', parent_code, str(child)], env=env, creationflags=subprocess.CREATE_NO_WINDOW)
try:
    deadline = time.monotonic()+15
    while not (work/'ready').exists() and time.monotonic()<deadline: time.sleep(.1)
    if not (work/'ready').exists(): raise RuntimeError('Driver child did not become ready')
    parent.kill();parent.wait(timeout=5)
    (work/'check').write_text('parent ended')
    deadline = time.monotonic()+10
    while not (work/'result.json').exists() and time.monotonic()<deadline: time.sleep(.1)
    result=json.loads((work/'result.json').read_text())
    result.update(driver=driver,artifact=str(work/'result.json'),inputActions=0)
    print(json.dumps(result));sys.exit(0 if result['outcome']=='Worked' else 1)
finally:
    if parent.poll() is None: parent.kill();parent.wait(timeout=5)
