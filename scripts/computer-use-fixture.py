"""Owned benign desktop fixture for execution, denial and focus-loss tests."""
import tkinter as tk
import sys
import json
from pathlib import Path
app=tk.Tk();app.title('SCT Desktop Acceptance Fixture');app.geometry('620x420+50+50')
text=tk.Text(app);text.pack(fill='both',expand=True);text.focus_set()
path=Path(sys.argv[1])
def persist():
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'text':text.get('1.0','end-1c'),'yview':text.yview(),'cursor':text.index('insert')}))
    temporary.replace(path)
    app.after(100,persist)
app.after(100,persist);app.mainloop()
