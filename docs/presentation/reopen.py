from pathlib import Path
import hashlib,json
P=Path(__file__).resolve().parent
m=json.loads((P/'bundle-manifest.json').read_text())
for f in m['files']:
 b=(P/f['path']).read_bytes();assert len(b)==f['bytes'] and hashlib.sha256(b).hexdigest()==f['sha256'],f['path']
c=json.loads((P/'case.json').read_text());e=json.loads((P/'ledger-export.json').read_text());h=c['originalSHA256'];assert all(hashlib.sha256((P/n).read_bytes()).hexdigest()==h for n in ['finished.pdf','prepared.pdf']);assert len(e['postingObservation'])==2 and len(e['package'])==2;assert all(p['hash']==h for p in e['package']);assert e['job'][0]['packageId']==c['afterPackageId'];assert c['beforeBinding']['observationId']!=c['afterBinding']['observationId'];assert c['oldReviewRefusal']['status']==409;assert not e['campaign'][0]['enabled'] and not e['run'] and not c['counts']['submissions'] and not c['counts']['modelCalls'];print(json.dumps({'content_files_verified':len(m['files']),'identical_pdf_sha256':h,'retained_posting_versions':2,'native_refusal_status':409,'campaign_off':True,'scope':'Recorded synthetic case; data checks do not restore the application or reproduce a real submission'},indent=2))
