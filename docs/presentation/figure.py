"""Draw the recorded PDF/source-binding transition, not a live application claim."""
from pathlib import Path
import json,hashlib,html
P=Path(__file__).resolve().parent
c=json.loads((P/'case.json').read_text());e=json.loads((P/'ledger-export.json').read_text());h=c['originalSHA256']
assert len(e['postingObservation'])==2 and len(e['package'])==2
assert all(x['hash']==h for x in e['package'])
assert c['oldReviewRefusal']['status']==409 and not e['campaign'][0]['enabled'] and not e['run']
assert hashlib.sha256((P/'finished.pdf').read_bytes()).hexdigest()==h==hashlib.sha256((P/'prepared.pdf').read_bytes()).hexdigest()
def svg(mobile):
 W,H=(420,1000)if mobile else(1200,650);o=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="t d"><title id="t">Same PDF. New posting. Fresh review.</title><desc id="d">One synthetic finished PDF is retained byte-for-byte in two prepared packages. Its old posting binding is refused with HTTP 409 after the employer text and deadline change. A new package bound to the new posting is explicitly reviewed. Campaign stays off, with zero model calls and zero submissions. This is an executed synthetic workflow, not a real employer application.</desc><style>text{{font-family:Arial,"DejaVu Sans",sans-serif}}</style><rect width="100%" height="100%" fill="#f5f8fa"/>']
 def t(x,y,s,size=17,color='#172d37',weight=400):o.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}">{html.escape(s)}</text>')
 def rect(x,y,w,ht,fill='#fff',stroke='#bacbd2'):o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{ht}" rx="4" fill="{fill}" stroke="{stroke}"/>')
 t(28,34,'Automation Hub / retained review context',13,'#52656f');t(28,83,'Same PDF.',36,weight=600);t(28,127,'Fresh review.',36,weight=600);t(28,164,'A file hash does not establish current approval.',15)
 stages=[('01 / Reviewed for source A','Python preferred.','Deadline: 1 April 2027','Old package remains retained.',c['beforeBinding']['contentHash'][:10],'#00758a'),('02 / A newer posting arrives','Python + signal processing.','Deadline: 1 March 2027','Old review request: HTTP 409',c['afterBinding']['contentHash'][:10],'#9a650c'),('03 / Prepare and review again','Same finished PDF; new binding.','Current source: B','New package explicitly approved.',c['afterBinding']['contentHash'][:10],'#00758a')]
 for i,(title,a,b,d,digest,color)in enumerate(stages):
  x,y,w,ht=(28,207+i*210,364,184)if mobile else(28+i*388,220,368,202);rect(x,y,w,ht);t(x+16,y+30,title,16,color,600);t(x+16,y+66,a,15);t(x+16,y+94,b,15);t(x+16,y+128,d,15,color,600);t(x+16,y+160,'Retained content '+digest,13,'#52656f')
 y=840 if mobile else 472;rect(28,y,W-56,70,'#e5eff2','#91acb8');t(44,y+26,'Original + both packages: identical PDF bytes',14,weight=600);t(44,y+52,'SHA-256 '+h[:20]+'…',14,'#52656f');t(28,y+106,'Campaign off · 0 model calls · 0 submissions',14,'#00758a',600);t(28,H-18,'Fictional local employer adapter. No live application outcome.',11,'#52656f');o.append('</svg>');(P/('binding-mobile.svg'if mobile else'binding.svg')).write_text(''.join(o))
svg(False);svg(True)
