"""Local-only MCP extension over the installed SelfConnect Core.

No model, credential or network client. The parent supplies a private evidence
directory; every operation rechecks the full target identity and shares the
native-input lock with terminal messaging. No desktop screenshot fallback.
"""
import ctypes
from ctypes import wintypes
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import tempfile
import time
import uuid
import atexit
from PIL import Image
import self_connect as sc
import sc_cli
from sc_mcp import build_server

server = build_server()
root = Path(os.environ['SCT_COMPUTER_EVIDENCE']).resolve()
root.mkdir(parents=True, exist_ok=True)
u = ctypes.windll.user32
k = ctypes.windll.kernel32
k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k.OpenProcess.restype = wintypes.HANDLE
k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
k.WaitForSingleObject.restype = wintypes.DWORD
k.CloseHandle.argtypes = [wintypes.HANDLE]
parent_handle = k.OpenProcess(0x00100000, False, os.getppid())
if not parent_handle: raise RuntimeError('Cannot bind desktop driver to its parent process')
atexit.register(lambda: k.CloseHandle(parent_handle))
u.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
u.GetAncestor.restype = wintypes.HWND
u.WindowFromPoint.argtypes = [wintypes.POINT]
u.WindowFromPoint.restype = wintypes.HWND
KEYS = {'enter','tab','escape','backspace','delete','home','end','pageup','pagedown','up','down','left','right','space','ctrl+a','ctrl+home','ctrl+end','shift+tab'}

def guard(target, foreground=False):
    if k.WaitForSingleObject(parent_handle, 0) != 258:
        raise RuntimeError('STOPPED: controlling process exited')
    result = sc_cli.verify_target(target['hwnd'], expected_pid=target['pid'], expected_exe=target['exe'], expected_class=target['className'], expected_title=target['title'], require_terminal=False)
    if not result['ok'] or u.IsIconic(target['hwnd']):
        raise RuntimeError('WINDOW_LOST: target identity changed, closed or minimized')
    if foreground and int(u.GetForegroundWindow()) != target['hwnd']:
        raise RuntimeError('WINDOW_LOST: foreground is not the authorized target')
    return result

def capture(target):
    guard(target)
    # Reuse Core ABI structures, but deliberately exclude its desktop BitBlt fallback.
    rect=wintypes.RECT();u.GetWindowRect(target['hwnd'],ctypes.byref(rect))
    width,height=rect.right-rect.left,rect.bottom-rect.top
    if width<=0 or height<=0 or width>6000 or height>4000:raise RuntimeError('Invalid capture dimensions')
    dc=sc.user32.GetDC(0);mem=sc.gdi32.CreateCompatibleDC(dc);bitmap=sc.gdi32.CreateCompatibleBitmap(dc,width,height)
    old=sc.gdi32.SelectObject(mem,bitmap)
    try:
        if not sc.user32.PrintWindow(target['hwnd'],mem,sc.PW_RENDERFULLCONTENT):raise RuntimeError('Window capture failed; desktop fallback disabled')
        header=sc.BITMAPINFOHEADER();header.biSize=ctypes.sizeof(sc.BITMAPINFOHEADER);header.biWidth=width;header.biHeight=-height;header.biPlanes=1;header.biBitCount=32;header.biCompression=0
        buf=ctypes.create_string_buffer(width*height*4)
        if not sc.gdi32.GetDIBits(mem,bitmap,0,height,buf,ctypes.byref(header),0):raise RuntimeError('Window pixels unavailable')
        image=Image.frombuffer('RGB',(width,height),buf,'raw','BGRX',0,1)
        artifact=uuid.uuid4().hex+'.png';image.save(root/artifact)
    finally:
        sc.gdi32.SelectObject(mem,old);sc.gdi32.DeleteObject(bitmap);sc.gdi32.DeleteDC(mem);sc.user32.ReleaseDC(0,dc)
    guard(target)
    return {'artifact':artifact,'sha256':hashlib.sha256((root/artifact).read_bytes()).hexdigest(),'width':width,'height':height,'capturedAt':int(time.time()*1000)}

def check_stop(action):
    name='stop-'+hashlib.sha256(str(action.get('sessionId','')).encode()).hexdigest()
    if (root/name).exists():raise RuntimeError('STOPPED: inspect any partial action')

def focus_checked(target, action):
    result=sc.focus_window_checked(target['hwnd'])
    if result['ok']:
        guard(target,True)
        return
    # Core can report a false-negative SetForegroundWindow return while the
    # asynchronous foreground transition already succeeded. Verify the outcome,
    # without repeating input or accepting attach/detach/identity failures.
    if result.get('error')=='foreground_not_established':
        deadline=time.monotonic()+1.0
        while time.monotonic()<deadline:
            check_stop(action);guard(target)
            if int(u.GetForegroundWindow())==target['hwnd']:
                time.sleep(.05);guard(target,True)
                return
            time.sleep(.025)
    raise RuntimeError('WINDOW_LOST: focus refused '+json.dumps(result))

def press_combo(target, action, combo):
    """Validated, foreground-bound key chord; never silently ignore a key name."""
    if combo not in KEYS:raise ValueError('Unsupported key combination')
    check_stop(action);guard(target,True)
    vks=[sc._resolve_vk(key) for key in combo.split('+')]
    events=(sc.INPUT*(len(vks)*2))()
    for i,(vk,release) in enumerate([(vk,False) for vk in vks]+[(vk,True) for vk in reversed(vks)]):
        events[i].type=sc.INPUT_KEYBOARD
        events[i].u.ki.wVk=vk
        events[i].u.ki.dwFlags=(sc.KEYEVENTF_KEYUP if release else 0)|(1 if vk in {33,34,35,36,37,38,39,40,46} else 0)
    accepted=sc.user32.SendInput(len(events),events,ctypes.sizeof(sc.INPUT))
    if accepted!=len(events):
        # Release any modifier that a partial delivery might have left pressed.
        releases=(sc.INPUT*len(vks))()
        for i,vk in enumerate(reversed(vks)):
            releases[i].type=sc.INPUT_KEYBOARD;releases[i].u.ki.wVk=vk;releases[i].u.ki.dwFlags=sc.KEYEVENTF_KEYUP
        sc.user32.SendInput(len(releases),releases,ctypes.sizeof(sc.INPUT))
        raise RuntimeError('Partial keyboard delivery; inspect before retrying')
    time.sleep(.03);guard(target,True)

@server.tool()
def computer_step(target: dict, action: dict, expected_observation: dict | None = None) -> dict:
    """Parent-governed, one-window action; no implicit submit or model call."""
    with open(Path(tempfile.gettempdir())/'sct-native-input.lock','a+b') as lock:
        lock.seek(0);lock.write(b'0');lock.flush();lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        kind=action.get('type');guard(target);check_stop(action)
        if kind not in {'observe','focus','click','type','keypress','scroll','wait','finish'}:raise ValueError('Unknown action')
        before=capture(target)
        if expected_observation and kind!='observe' and (before['width']!=expected_observation['width'] or before['height']!=expected_observation['height']):raise RuntimeError('STALE_OBSERVATION: target resized; observe again')
        if kind=='focus':
            focus_checked(target,action)
        elif kind in {'click','type','keypress','scroll'}:
            # Approving in the app temporarily focuses its own window. Only this
            # exact parent-owned approval window may return focus to the target.
            approval=int(os.environ.get('SCT_APPROVAL_WINDOW','0'))
            if approval and int(u.GetForegroundWindow())==approval:
                focus_checked(target,action)
            guard(target,True)
            if kind=='click':
                point=action['point'];x,y=point['x'],point['y']
                if not(0<=x<before['width'] and 0<=y<before['height']):raise ValueError('Coordinates outside capture')
                rect=wintypes.RECT();u.GetWindowRect(target['hwnd'],ctypes.byref(rect));pt=wintypes.POINT(rect.left+x,rect.top+y)
                hit=u.WindowFromPoint(pt)
                if int(u.GetAncestor(hit,2) or hit)!=target['hwnd']:raise RuntimeError('WINDOW_LOST: another window covers click target')
                guard(target,True);sc.click_at(pt.x,pt.y,action.get('button','left'));guard(target,True)
            elif kind=='type':
                text=action['text']
                if not isinstance(text,str) or not 1<=len(text)<=2000:raise ValueError('Invalid text length')
                for char in text:
                    check_stop(action);guard(target,True)
                    if char in {'\n','\t'}:
                        press_combo(target,action,'enter' if char=='\n' else 'tab')
                        continue
                    if ord(char)<32:raise ValueError('Unsupported text control character')
                    result=sc_cli.send_text_to_window(target['hwnd'],char,allow_input=True,char_delay=0,expected_pid=target['pid'],expected_exe=target['exe'],expected_class=target['className'],expected_title=target['title'],require_terminal=False)
                    if not result['ok']:raise RuntimeError('Partial text input; inspect before retrying')
            elif kind=='keypress':
                combos=action['keys']
                if not isinstance(combos,list) or not 1<=len(combos)<=5 or any(k not in KEYS for k in combos):raise ValueError('Unsupported key combination')
                for combo in combos:
                    press_combo(target,action,combo)
            else:
                delta=action['delta']
                if type(delta) is not int or delta==0 or not -10<=delta<=10:raise ValueError('Invalid scroll')
                point=action.get('point',{'x':before['width']//2,'y':before['height']//2})
                x,y=point['x'],point['y']
                if type(x) is not int or type(y) is not int or not(0<=x<before['width'] and 0<=y<before['height']):raise ValueError('Coordinates outside capture')
                rect=wintypes.RECT();u.GetWindowRect(target['hwnd'],ctypes.byref(rect));pt=wintypes.POINT(rect.left+x,rect.top+y)
                hit=u.WindowFromPoint(pt)
                if int(u.GetAncestor(hit,2) or hit)!=target['hwnd']:raise RuntimeError('WINDOW_LOST: another window covers scroll target')
                guard(target,True)
                # Normalized actions use positive=down; Win32 wheel uses positive=up.
                if not sc.user32.PostMessageW(hit,sc.WM_MOUSEWHEEL,((-delta*120)&0xffff)<<16,(pt.x&0xffff)|((pt.y&0xffff)<<16)):raise RuntimeError('Scroll delivery failed')
                guard(target,True)
        elif kind=='wait':
            ms=action['waitMs']
            if not isinstance(ms,int) or not 0<=ms<=2000:raise ValueError('Invalid wait')
            time.sleep(ms/1000)
        time.sleep(.08)
        after=capture(target)
        return {'executed':True,'before':before,'observation':after,'stateChanged':before['sha256']!=after['sha256'],'foreground':int(u.GetForegroundWindow())==target['hwnd']}

if __name__=='__main__':server.run(transport='stdio')
