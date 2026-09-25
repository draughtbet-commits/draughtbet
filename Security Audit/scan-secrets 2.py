import subprocess,json,re,pathlib
repo='/workspace/scratch/60ee09a64eff/security-audit-20260909'
def git(*args):return subprocess.check_output(['git','-C',repo,*args])
patterns={
 'private-key':rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'github-token':rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})',
 'aws-access-key':rb'(?:AKIA|ASIA)[A-Z0-9]{16}',
 'live-payment-key':rb'(?:sk_live_|FLWSECK-)[A-Za-z0-9_-]{20,}',
 'jwt-literal':rb'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}',
}
objects=git('rev-list','--objects','--all').decode().splitlines();rows=[];scanned=0
proc=subprocess.Popen(['git','-C',repo,'cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
for entry in objects:
 parts=entry.split(' ',1);oid=parts[0];name=parts[1] if len(parts)>1 else ''
 proc.stdin.write((oid+'\n').encode());proc.stdin.flush()
 header=proc.stdout.readline().decode().split();size=int(header[2]);body=proc.stdout.read(size);proc.stdout.read(1)
 if header[1]!='blob' or b'\x00' in body or size>2_000_000:continue
 scanned+=1
 for kind,pattern in patterns.items():
  for match in re.finditer(pattern,body):
   rows.append({'object':oid,'path':name,'kind':kind,'line':body[:match.start()].count(b'\n')+1})
proc.stdin.close();proc.wait()
result={'text_blobs_scanned':scanned,'scope':'all locally fetched refs; selected credential patterns only; no entropy scanner','candidates':rows}
pathlib.Path('/workspace/scratch/60ee09a64eff/security-evidence-20260909/secret-scan.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
