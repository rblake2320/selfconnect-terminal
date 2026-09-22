"""Guarded native SelfConnect input for the Electron terminal.

Uses installed SelfConnect APIs, UIA control focus, and a separate checked
hardware Enter. Acceptance is not delivery; the caller must read back an ACK.
"""
import argparse
import json
import time
import os
import tempfile
import msvcrt
import self_connect as sc
from sc_cli import verify_target, send_text_to_window
from pywinauto import Desktop

p=argparse.ArgumentParser()
p.add_argument('--hwnd',type=lambda s:int(s,0),required=True)
p.add_argument('--pid',type=int,required=True)
p.add_argument('--title',default='SelfConnect Terminal')
p.add_argument('--text',required=True)
p.add_argument('--submit',action='store_true')
args=p.parse_args()
expected=dict(expected_pid=args.pid,expected_exe='SelfConnect Terminal.exe',expected_class='Chrome_WidgetWin_1',expected_title=args.title,require_terminal=False)
result={'hwnd':args.hwnd,'pid':args.pid,'delivery_verified':False}
lock_file=None
try:
 # All users of this adapter share one OS-released native-input lock.
 lock_file=open(os.path.join(tempfile.gettempdir(),'sct-native-input.lock'),'a+b')
 lock_file.seek(0);lock_file.write(b'0');lock_file.flush();lock_file.seek(0)
 msvcrt.locking(lock_file.fileno(),msvcrt.LK_NBLCK,1)
 result['serialized_input']=True
 if '\r' in args.text or '\n' in args.text:raise ValueError('Use a single-line message; submission is a separate checked key.')
 guard=verify_target(args.hwnd,**expected);result['guard']=guard
 if not guard['ok']:raise RuntimeError('Target identity mismatch; nothing sent.')
 focus=sc.focus_window_checked(args.hwnd);result['focus']=focus
 if not focus['ok']:raise RuntimeError('Target foreground could not be established.')
 control=Desktop(backend='uia').window(handle=args.hwnd).child_window(title='SelfConnect terminal input',control_type='Edit')
 control.wait('exists enabled',timeout=5);control.set_focus()
 # Abort on focus theft before every character, including before submission.
 accepted=0
 for ch in args.text:
  if int(sc.user32.GetForegroundWindow())!=args.hwnd:raise RuntimeError('Foreground changed; partial text was not submitted.')
  sent=send_text_to_window(args.hwnd,ch,allow_input=True,char_delay=0.005,**expected)
  if not sent['ok']:raise RuntimeError('Input rejected; partial text was not submitted.')
  accepted+=1
 result['characters_accepted']=accepted
 if args.submit:
  guard=verify_target(args.hwnd,**expected)
  if not guard['ok']:raise RuntimeError('Target changed before submission.')
  result['submit']=sc.hardware_enter_checked(args.hwnd)
  if not result['submit']['ok']:raise RuntimeError('Submission rejected or ambiguous; inspect before retrying.')
 result['ok']=True
except Exception as e:
 result['ok']=False;result['error']=str(e)
finally:
 if lock_file is not None:lock_file.close()
print(json.dumps(result,ensure_ascii=True))
raise SystemExit(0 if result['ok'] else 1)
