import base64,hashlib,io,json,os,re,subprocess,tarfile,urllib.parse,urllib.request
from pathlib import Path
repo='workagi/jianwei-werss'
digest='sha256:247875c2610e9d155d6d544c078302b6f0da4b93b640882dc41cc1d0547d0131'
auth=base64.b64encode((os.environ['GITHUB_ACTOR']+':'+os.environ['GH_TOKEN']).encode()).decode()
url='https://ghcr.io/token?'+urllib.parse.urlencode({'scope':'repository:'+repo+':pull','service':'ghcr.io'})
with urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Basic '+auth}),timeout=60) as r:token=json.load(r)['token']
headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json'}
def read(kind,digest):
 with urllib.request.urlopen(urllib.request.Request('https://ghcr.io/v2/'+repo+'/'+kind+'/'+digest,headers=headers),timeout=180) as r:data=r.read()
 assert 'sha256:'+hashlib.sha256(data).hexdigest()==digest
 return data
index=json.loads(read('manifests',digest))
manifests={m['platform']['architecture']:json.loads(read('manifests',m['digest'])) for m in index['manifests'] if m.get('platform',{}).get('architecture') in ['amd64','arm64']}
report={'scope':'targeted WeRSS candidate review and executable-format check','allPlatformLayersIdentical':[l['digest'] for l in manifests['amd64']['layers']]==[l['digest'] for l in manifests['arm64']['layers']],'executables':[],'sshTokenCandidates':[],'testKeys':[],'configs':[],'sourceChecks':[]}
for n in [0,1,2,14,15]:
 data=read('blobs',manifests['amd64']['layers'][n]['digest'])
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:*') as tar:
  for e in tar:
   if not e.isfile():continue
   name=e.name.removeprefix('./')
   selected=name in ['bin/dash','bin/bash','usr/bin/ssh','usr/bin/ssh-add','usr/bin/ssh-agent','usr/bin/ssh-keygen','usr/bin/ssh-keyscan','usr/lib/openssh/ssh-keysign','usr/lib/openssh/ssh-pkcs11-helper','usr/lib/openssh/ssh-sk-helper','usr/local/bin/python3.13','app/.env.example','app/.arts/launch.json','app/compose/docker-compose.yaml','app/compose/test.yaml','app/config-node.yaml','app/config.example.yaml','app/config.yaml','app/data_sync.py','app/core/config.py','app/core/auth.py','app/FIX_CASCADE_CONFIG.md','app/docs/cache-config.md'] or name.startswith('usr/local/lib/python3.13/test/certdata/')
   if not selected:continue
   b=tar.extractfile(e).read()
   if b.startswith(b'\x7fELF'):
    endian='little' if b[5]==1 else 'big';machine=int.from_bytes(b[18:20],endian)
    report['executables'].append({'path':name,'elfMachine':machine,'architecture':{62:'x86_64',183:'aarch64'}.get(machine,'other')})
   if name.startswith(('usr/bin/ssh','usr/lib/openssh/')):
    values=set(re.findall(rb'\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b',b))
    report['sshTokenCandidates'].append({'path':name,'count':len(values),'allAreSecurityKeyAlgorithms':all(v.startswith((b'sk-ssh-ed25519',b'sk-ecdsa-sha2-nistp')) for v in values)})
   if name.startswith('usr/local/lib/python3.13/test/certdata/') and b'PRIVATE KEY-----' in b:
    report['testKeys'].append({'path':name,'classification':'CPython test fixture','sha256':hashlib.sha256(b).hexdigest()})
   if name.startswith('app/'):
    text=b.decode(errors='replace');row={'path':name,'sha256':hashlib.sha256(b).hexdigest(),'assignments':[],'credentialUrls':[]}
    for mt in re.finditer(r'^\s*[\"\']?([\w.-]*(?:secret|password|passwd|token|api_key|api_secret|access_key|cookie|ticket)[\w.-]*)[\"\']?\s*[:=]\s*([^\r\n]*)',text,re.I|re.M):
     val=mt[2].split('#',1)[0].strip().strip('\"\'')
     cls='empty' if not val else 'runtime-reference' if re.search(r'\$\{|getenv|environ|process\.env',val) else 'example-placeholder' if re.search(r'your|example|new_key|new_secret|old_key|old_secret|test|change.me|xxxx|^root$|^password$|^123456$|^admin|^666666$',val,re.I) else 'parameter' if 'expire' in mt[1] else 'literal-review-required'
     row['assignments'].append({'key':mt[1],'class':cls})
    for mt in re.finditer(r'(?:postgres(?:ql)?|mysql(?:\+pymysql)?|redis|https?)://([^\s:/\"\'<>]+):([^\s@/\"\'<>]+)@([^\s/\"\'<>]*)',text):
     pair=mt[1]+':'+mt[2]
     cls='example-default' if pair in ['user:password','user:pass','username:password','root:root','root:123456','root:password','monitor:monitor','admin:admin'] or re.search(r'your|example|test|\$\{|\{|\}|^root:',pair,re.I) else 'literal-review-required'
     row['credentialUrls'].append({'classification':cls,'loopbackHost':mt[3].startswith(('localhost','127.0.0.1'))})
    report['configs'].append(row)
    if name in ['app/core/config.py','app/core/auth.py']:
     report['sourceChecks'].append({'path':name,'generatesRandomSecret':bool(re.search(r'token_hex|token_urlsafe|urandom|uuid4',text)),'readsSecretEnvironment':'SECRET_KEY' in text,'hasDefaultPassword':bool(re.search(r'admin@123|123456|admin123',text))})
Path('audit-output').mkdir(exist_ok=True)
Path('audit-output/werss-focus.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'allPlatformLayersIdentical':report['allPlatformLayersIdentical'],'executables':report['executables'],'configFileCount':len(report['configs'])}))
