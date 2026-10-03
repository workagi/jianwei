import base64, hashlib, json, os, re, shutil, subprocess, tarfile, urllib.parse, urllib.request
from pathlib import Path, PurePosixPath

DIGESTS = {
    'web': 'sha256:8c6db0de0f23fffc8b1532a2b282b68164e78a08f0de7f45d4d7ad97eb3b0bb6',
    'worker': 'sha256:716a0c79b7b47f1166fc89dcbf893e5da47a88716970720852fc324be0d4d134',
    'migrate': 'sha256:63bb2302e5ccdffa56a86d0ecc0ed9009c4a150ddf02c0007e13c74a64e0a6bb',
    'werss': 'sha256:247875c2610e9d155d6d544c078302b6f0da4b93b640882dc41cc1d0547d0131',
}
component, arch = os.environ['COMPONENT'], os.environ['ARCH']
repo = 'workagi/jianwei-' + component
work = Path(os.environ['RUNNER_TEMP']) / 'image-audit'
work.mkdir()
out = Path('audit-output'); out.mkdir(exist_ok=True)
auth = base64.b64encode((os.environ['GITHUB_ACTOR'] + ':' + os.environ['GH_TOKEN']).encode()).decode()
url = 'https://ghcr.io/token?' + urllib.parse.urlencode({'scope': 'repository:'+repo+':pull', 'service':'ghcr.io'})
with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': 'Basic '+auth}), timeout=60) as r:
    token = json.load(r)['token']
headers = {'Authorization': 'Bearer '+token, 'Accept':'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'}
def read_json(kind, digest):
    with urllib.request.urlopen(urllib.request.Request('https://ghcr.io/v2/'+repo+'/'+kind+'/'+digest, headers=headers), timeout=120) as r:
        data = r.read()
    assert 'sha256:'+hashlib.sha256(data).hexdigest() == digest
    return json.loads(data)
index = read_json('manifests', DIGESTS[component])
child = next(m for m in index['manifests'] if m.get('platform',{}).get('architecture') == arch and m['platform'].get('os') == 'linux')
manifest = read_json('manifests', child['digest'])
config = read_json('blobs', manifest['config']['digest'])
assert config['architecture'] == arch
labels = config['config'].get('Labels', {})
assert labels['org.opencontainers.image.revision'] == '65d16478fb8387813d5fa832d5e3787dea607203'
assert labels['org.opencontainers.image.version'] == 'v0.3.0'
report = {'component':component, 'architecture':arch, 'indexDigest':DIGESTS[component], 'manifestDigest':child['digest'], 'revision':labels['org.opencontainers.image.revision'], 'scanner':'trivy 0.75.0 + byte patterns and file inventory', 'scope':'all regular files in every published layer, including overwritten/deleted files; image configuration/history', 'layers':[], 'secrets':[], 'patternFindings':[], 'sensitivePaths':[], 'configAssignments':[], 'fileCount':0, 'byteCount':0}
patterns = {
 'private-key': rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
 'github-token': rb'\bgh[opusr]_[A-Za-z0-9]{20,}\b',
 'model-api-key': rb'\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b',
 'xai-token': rb'\bxai-[A-Za-z0-9_-]{20,}\b',
 'huggingface-token': rb'\bhf_[A-Za-z0-9]{20,}\b',
 'aws-access-key': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
 'google-api-key': rb'\bAIza[0-9A-Za-z_-]{30,}\b',
 'slack-token': rb'\bxox[baprs]-[0-9A-Za-z-]{20,}\b',
 'stripe-live-key': rb'\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b',
 'credential-url': rb'(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?)://[^\s:/\x00]+:[^\s@/\x00]+@',
}
patterns = {k:re.compile(v) for k,v in patterns.items()}
def scan_patterns(data, path, layer, seen):
    for rule, pat in patterns.items():
        if rule not in seen and pat.search(data):
            seen.add(rule); report['patternFindings'].append({'layer':layer,'path':path,'rule':rule})
def trivy_scan(directory, layer):
    raw = work/'raw.json'
    subprocess.run(['./trivy','fs','--scanners','secret','--format','json','--output',str(raw),'--quiet',str(directory)], check=True, timeout=600)
    for result in json.loads(raw.read_text()).get('Results',[]):
        for s in result.get('Secrets',[]):
            report['secrets'].append({'layer':layer,'path':result['Target'],'rule':s['RuleID'],'title':s['Title'],'severity':s['Severity'],'startLine':s.get('StartLine'),'endLine':s.get('EndLine')})
    raw.unlink()
confdir=work/'config'; confdir.mkdir()
cfgbytes=json.dumps(config).encode(); (confdir/'image-config.json').write_bytes(cfgbytes)
scan_patterns(cfgbytes,'image-config.json','config',set()); trivy_scan(confdir,'config')
report['environmentNames']=[e.split('=',1)[0] for e in config['config'].get('Env',[])]
report['sensitiveEnvironment']=[{'name':e.split('=',1)[0],'valuePresent':bool(e.split('=',1)[1])} for e in config['config'].get('Env',[]) if re.search(r'(secret|token|password|api.?key|database|dsn)',e.split('=',1)[0],re.I)]
shutil.rmtree(confdir)
for n, layer in enumerate(manifest['layers']):
    archive=work/'layer.tar'; h=hashlib.sha256()
    with urllib.request.urlopen(urllib.request.Request('https://ghcr.io/v2/'+repo+'/blobs/'+layer['digest'],headers=headers),timeout=180) as response, archive.open('wb') as dst:
        while chunk:=response.read(1024*1024): h.update(chunk); dst.write(chunk)
    assert 'sha256:'+h.hexdigest()==layer['digest']
    root=work/('layer-'+str(n)); root.mkdir()
    count=0; size=0
    with tarfile.open(archive,'r:*') as tar:
        for entry in tar:
            if not entry.isfile(): continue
            path=PurePosixPath(entry.name)
            assert not path.is_absolute() and '..' not in path.parts
            normalized=str(path); dest=root/normalized; dest.parent.mkdir(parents=True,exist_ok=True)
            seen=set(); tail=b''; first=b''
            with tar.extractfile(entry) as src, dest.open('wb') as dst:
                while chunk:=src.read(1024*1024):
                    if not first: first=chunk[:65536]
                    scan_patterns(tail+chunk,normalized,n,seen); tail=chunk[-512:]; dst.write(chunk)
            count+=1; size+=entry.size
            suspicious=re.search(r'(^|/)(\.env[^/]*|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|credentials[^/]*|cookies?[^/]*|session[^/]*|[^/]+\.(?:sqlite3?|db|sql|pem|key|p12|pfx|log))$',normalized,re.I)
            runtime=normalized.startswith(('app/data/','app/config/','app/logs/','app/.env','root/.ssh/','root/.aws/','root/.docker/','home/node/.ssh/'))
            if suspicious or runtime or first.startswith(b'SQLite format 3\0'):
                report['sensitivePaths'].append({'layer':n,'path':normalized,'size':entry.size,'sqliteMagic':first.startswith(b'SQLite format 3\0')})
            if normalized.startswith('app/') and re.search(r'(config|\.env|settings|\.npmrc|\.ya?ml$)',normalized,re.I) and entry.size<1024*1024 and b'\0' not in first:
                text=dest.read_text(errors='replace')
                for match in re.finditer(r'^\s*[\"\']?([\w.-]*(?:secret|password|passwd|token|api_key|access_key|database_url|username)[\w.-]*)[\"\']?\s*[:=]\s*([^\r\n]*)',text,re.I|re.M):
                    val=match[2].strip().strip('\"\'').strip()
                    cls='empty' if not val else 'runtime-reference' if re.search(r'\$\{|getenv|environ|process\.env',val) else 'literal-review-required'
                    report['configAssignments'].append({'layer':n,'path':normalized,'key':match[1],'valueClass':cls})
    trivy_scan(root,n)
    report['layers'].append({'index':n,'digest':layer['digest'],'compressedBytes':layer['size'],'regularFiles':count,'uncompressedBytes':size})
    report['fileCount']+=count; report['byteCount']+=size
    shutil.rmtree(root); archive.unlink()
    print(json.dumps({'component':component,'architecture':arch,'layer':n,'files':count,'bytes':size}),flush=True)
output=out/(component+'-'+arch+'.json')
output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'component':component,'architecture':arch,'layers':len(report['layers']),'files':report['fileCount'],'secretCandidates':len(report['secrets']),'patternCandidates':len(report['patternFindings']),'sensitivePaths':len(report['sensitivePaths'])}))
