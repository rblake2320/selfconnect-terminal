"""Deterministic focus-race regression; native calls are substituted, no UI input."""
import importlib.util
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

os.environ['SCT_COMPUTER_EVIDENCE']=tempfile.mkdtemp(prefix='sct-focus-regression-')
spec=importlib.util.spec_from_file_location('driver',sys.argv.pop(1))
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
target={'hwnd':123};action={'sessionId':'regression'}
class FocusRegression(unittest.TestCase):
    def run_case(self, reason, foreground, allow):
        with patch.object(driver.sc,'focus_window_checked',return_value={'ok':False,'error':reason}),patch.object(driver,'guard') as guard,patch.object(driver.u,'GetForegroundWindow',return_value=foreground),patch.object(driver,'check_stop'):
            if allow:
                driver.focus_checked(target,action)
                guard.assert_any_call(target,True)
            else:
                with self.assertRaisesRegex(RuntimeError,'WINDOW_LOST'):driver.focus_checked(target,action)
    def test_false_native_return_with_observed_target(self):self.run_case('foreground_not_established',123,True)
    def test_other_foreground_remains_refused(self):self.run_case('foreground_not_established',456,False)
    def test_detach_failure_never_downgraded(self):self.run_case('detach_thread_input_failed',123,False)
    def test_attach_failure_never_downgraded(self):self.run_case('attach_thread_input_failed',123,False)
unittest.main()
