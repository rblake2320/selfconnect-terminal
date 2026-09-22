"""Read-only verification of actual CLI transcripts and native-send receipts."""
import json,pathlib,re,datetime
out=pathlib.Path(__file__).resolve().parent.parent/'docs/ecosystem-20260922'
start=(out/'trio-started-at.txt').read_text(encoding='utf-8-sig').strip()
base=pathlib.Path.home()/'.claude/projects/D--Projects-SelfConnect-selfconnect-terminal'
ids={'A':'791e8a13-b463-46ff-97c9-dc56d5f89a08','B':'95f5f5e0-3698-4ffd-8e96-864787d28c07','C':'fb01fe5e-551e-4eeb-ab52-9e832a8fa535'}
events=[]
for role,sid in ids.items():
 for line in (base/(sid+'.jsonl')).read_text(encoding='utf-8').splitlines():
  d=json.loads(line)
  if d.get('timestamp','')<start:continue
  content=d.get('message',{}).get('content')
  if d.get('type')=='user' and isinstance(content,str):events.append({'role':role,'session':sid,'timestamp':d.get('timestamp'),'kind':'received','text':content})
  if isinstance(content,list):
   for c in content:
    cmd=c.get('input',{}).get('command','')
    if c.get('type')=='tool_use' and c.get('name')=='Bash' and 'selfconnect-peer.py' in cmd and '--submit' in cmd and '--hwnd' in cmd:
     match=re.search(r'--text "([^"]+)"',cmd);text=match.group(1) if match else ''
     if text=='$MSG':text=re.search(r'MSG="([^"]+)"',cmd).group(1)
     events.append({'role':role,'session':sid,'timestamp':d.get('timestamp'),'kind':'send','text':text,'command':cmd})
events.sort(key=lambda e:e['timestamp']);checks=[]
for e in [x for x in events if x['kind']=='send']:
 receiver={'A':'B','B':'C','C':'A'}[e['role']]
 delivered=any(x['kind']=='received' and x['role']==receiver and x['text'].strip()==e['text'] and x['timestamp']>=e['timestamp'] for x in events)
 checks.append({'from':e['role'],'to':receiver,'message':e['text'],'receivedInTargetTranscript':delivered})
receipts=[]
for p in sorted(out.glob('trio-*-send-*.json')):
 data=next(json.loads(line) for line in p.read_text(encoding='utf-8').splitlines() if line.startswith('{'))
 receipts.append({'file':p.name,'ok':data.get('ok'),'serialized':data.get('serialized_input'),'guardOk':data.get('guard',{}).get('ok'),'submitOk':data.get('submit',{}).get('ok')})
complete=json.loads((out/'trio-complete.json').read_text()) if (out/'trio-complete.json').exists() else None
result={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'events':events,'exchanges':checks,'receipts':receipts,'completion':complete,'worked':len(checks)==5 and all(c['receivedInTargetTranscript'] for c in checks) and len(receipts)==5 and all(all(r[k] for k in ['ok','serialized','guardOk','submitOk']) for r in receipts) and bool(complete and complete.get('complete'))}
(out/'trio-observation.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({'exchanges':len(checks),'received':sum(c['receivedInTargetTranscript'] for c in checks),'receiptCount':len(receipts),'complete':bool(complete),'worked':result['worked']}))
