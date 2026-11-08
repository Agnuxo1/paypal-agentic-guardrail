"""Original, deterministic README diagrams. CPU only; Pillow, no external media."""
# SPDX-License-Identifier: MIT
# Francisco Angulo de Lafuente | ORCID 0009-0001-1634-7063
from pathlib import Path
import hashlib, json, math
import PIL
from PIL import Image, ImageDraw, ImageFont, ImageChops

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'readme-gifs-20261108';OUT.mkdir(exist_ok=True)
W,H,S,N,MS=1280,672,2,60,100
BG='#0B1324'; PANEL='#121F33'; LINE='#34465D'; INK='#F0F5FB'; MUTED='#B1C2D6'; TEAL='#40DABD'; BLUE='#73AAFF'; AMBER='#F1C76D'
FONT=Path('C:/Windows/Fonts/segoeui.ttf'); BOLD=Path('C:/Windows/Fonts/seguisb.ttf'); MONO=Path('C:/Windows/Fonts/consola.ttf')
assert all(p.is_file() for p in (FONT,BOLD,MONO))
network_path=ROOT/'sandbox-private/sandbox-web-1794169596328.json'
if not network_path.is_file():network_path=ROOT/'SANDBOX_NETWORK_RECEIPT.json'
network=json.loads(network_path.read_text())
assert network['actual_network'] and network['sandbox_verified']
assert [r['http_status'] for r in network['exchanges']]==[201,200]
assert network['capture_attempted'] is False
readme_path=ROOT/'README_DELIVERED.md'
if not readme_path.is_file():readme_path=ROOT.parents[1]/'README.md'
analysis=readme_path.read_text(encoding='utf-8')
assert '540 runs' in analysis and '180 runs per arm' in analysis and '30 cases' in analysis
assert 30*3*2==180 and 180*3==540
BOUNDS=[]

def f(size,bold=False,mono=False):return ImageFont.truetype(str(MONO if mono else BOLD if bold else FONT),round(size*S))
def text(d,xy,value,size=22,fill=INK,bold=False,mono=False,anchor='la'):
    pt=(round(xy[0]*S),round(xy[1]*S)); font=f(size,bold,mono)
    box=d.textbbox(pt,value,font=font,anchor=anchor)
    assert box[0]>=0 and box[1]>=0 and box[2]<=W*S and box[3]<=H*S,(value,box)
    BOUNDS.append((value,box));d.text(pt,value,font=font,fill=fill,anchor=anchor)
def rr(d,b,fill=PANEL,outline=LINE,radius=18,width=2):
    d.rounded_rectangle(tuple(round(x*S) for x in b),radius=radius*S,fill=fill,outline=outline,width=width*S)
def line(d,points,fill=LINE,width=2):d.line([(round(x*S),round(y*S)) for x,y in points],fill=fill,width=width*S,joint='curve')
def arrow(d,start,end,fill=LINE,width=2):
    line(d,[start,end],fill,width);x,y=end;dx,dy=x-start[0],y-start[1];a=math.atan2(dy,dx)
    p=[(x,y),(x-10*math.cos(a-.5),y-10*math.sin(a-.5)),(x-10*math.cos(a+.5),y-10*math.sin(a+.5))]
    d.polygon([(round(a*S),round(b*S)) for a,b in p],fill=fill)
def dot(d,start,end,t,color=TEAL):
    t%=1;x=start[0]+(end[0]-start[0])*t;y=start[1]+(end[1]-start[1])*t
    for k in range(4,0,-1):
        q=max(0,t-k*.035);px=start[0]+(end[0]-start[0])*q;py=start[1]+(end[1]-start[1])*q
        r=3;d.ellipse(((px-r)*S,(py-r)*S,(px+r)*S,(py+r)*S),fill=LINE)
    d.ellipse(((x-5)*S,(y-5)*S,(x+5)*S,(y+5)*S),fill=color)
def base(number,title,subtitle,source):
    im=Image.new('RGB',(W*S,H*S),BG);d=ImageDraw.Draw(im)
    # One editorial rail, all informational text remains static throughout the loop.
    d.rectangle((0,0,W*S,6*S),fill=TEAL)
    text(d,(48,34),'PAYPAL AGENTIC GUARDRAIL  /  '+number,18,TEAL,True)
    text(d,(48,74),title,38,bold=True)
    text(d,(48,128),subtitle,22,MUTED)
    line(d,[(48,593),(1232,593)],LINE,1)
    text(d,(48,606),source,16,MUTED)
    text(d,(48,636),'Francisco Angulo de Lafuente  |  ORCID 0009-0001-1634-7063',17,INK,True)
    return im,d

def architecture(t):
    im,d=base('A1','Operator policy bounds each request','Architecture schematic · declared operations and bounded values','Source: src/broker.js + policy/operations.json | Schematic')
    rr(d,(48,288,322,428));text(d,(73,309),'AI agent',30,bold=True)
    text(d,(73,355),'Operation + values',23,MUTED);text(d,(73,390),'inside declared ranges',20,MUTED)
    rr(d,(456,266,824,448),outline=TEAL)
    text(d,(483,291),'Policy broker',31,bold=True)
    for i,label in enumerate(['VALIDATE','BIND','LIMIT']):
        x=483+i*104; active=int(t*3)%3==i
        rr(d,(x,352,x+94,397),fill='#193A42' if active else PANEL,outline=TEAL if active else LINE,radius=9)
        text(d,(x+47,373),label,17,TEAL if active else INK,True,anchor='mm')
    text(d,(483,418),'Operator bounds applied last',20,MUTED)
    rr(d,(958,288,1232,428));text(d,(984,309),'PayPal Sandbox',26,bold=True)
    text(d,(984,358),'Fixed host + endpoint',20,MUTED)
    rr(d,(500,185,780,240),radius=12);text(d,(640,213),'OPERATOR POLICY',19,TEAL,True,anchor='mm')
    rr(d,(500,488,780,542),radius=12);text(d,(640,515),'CREDENTIAL SOURCE',18,MUTED,True,anchor='mm')
    arrow(d,(640,240),(640,266),TEAL);arrow(d,(640,488),(640,448),MUTED)
    arrow(d,(322,358),(456,358));arrow(d,(824,358),(958,358))
    dot(d,(322,358),(456,358),t*2);dot(d,(824,358),(958,358),t*2-.5)
    text(d,(48,556),'AI proposes bounded choices; the broker constructs the request.',22,MUTED)
    return im

def shared_cases(t):
    im,d=base('A2','540 runs, 30 shared cases','Offline study · repetitions of a case are not independent observations','Source: README + docs/recovery-20261108/SECONDARY_ANALYSIS.md')
    rr(d,(48,238,402,452),outline=BLUE)
    text(d,(78,270),'30 fixed cases',33,bold=True)
    text(d,(78,326),'3 models × 2 repetitions',23,MUTED)
    text(d,(78,377),'Same cases in every arm',22,MUTED)
    labels=['Broker','Control','Written rules']
    for i,label in enumerate(labels):
        y=184+i*102;rr(d,(790,y,1232,y+93),outline=TEAL if i==0 else LINE)
        text(d,(818,y+16),label,28,bold=True);text(d,(1204,y+46),'180 runs',23,MUTED,anchor='rm')
        start=(402,345);end=(790,y+46);arrow(d,start,end)
        dot(d,start,end,t+i/3,TEAL if i==0 else BLUE)
    rr(d,(48,510,1232,566),fill='#152C3A',outline=LINE,radius=12)
    text(d,(640,538),'Group repeated observations by their original case.',26,INK,True,anchor='mm')
    return im

def sandbox(t):
    im,d=base('A3','Sandbox create + read verified','Separate acceptance check · 8 November 2026 · schematic of the recorded exchange','Source: docs/recovery-20261108/SANDBOX_ACCEPTANCE_20261108.md')
    cards=[(48,262,590,428),(690,262,1232,428)]
    for i,(box,verb,route,status) in enumerate(zip(cards,['CREATE','READ'],['POST /v2/checkout/orders','GET /v2/checkout/orders/:id'],['201 CREATED','200 CREATED'])):
        rr(d,box,outline=TEAL if int(t*2)%2==i else LINE)
        x=box[0]+26;text(d,(x,282),verb,19,TEAL,True)
        text(d,(x,322),route,21,MUTED,mono=True)
        text(d,(x,368),status,36,bold=True)
    arrow(d,(590,345),(690,345));dot(d,(590,345),(690,345),t*2)
    rr(d,(48,467,1232,519),fill='#183337',outline=LINE,radius=11)
    text(d,(640,493),'EUR 1 test order  |  No approval or capture',25,INK,True,anchor='mm')
    text(d,(48,545),'Two endpoints checked. The complete benchmark remains offline.',23,MUTED)
    return im

def render(name,fn):
    images=[fn(i/N).resize((W,H),Image.Resampling.LANCZOS) for i in range(N)]
    # A shared palette prevents flickering quantization; quantize only original rendered frames.
    swatch=Image.new('RGB',(W*3,H));
    for col,idx in enumerate([0,N//3,2*N//3]):swatch.paste(images[idx],(col*W,0))
    palette=swatch.quantize(colors=128,method=Image.Quantize.MEDIANCUT)
    frames=[im.quantize(palette=palette,dither=Image.Dither.NONE) for im in images]
    path=OUT/name
    frames[0].save(path,save_all=True,append_images=frames[1:],duration=MS,loop=0,optimize=True,disposal=1,
                   comment=b'Original deterministic illustration | Francisco Angulo de Lafuente | ORCID 0009-0001-1634-7063 | MIT')
    with Image.open(path) as actual:
        assert actual.format=='GIF' and actual.size==(W,H) and actual.n_frames>1 and actual.info.get('loop')==0
        duration=0;decoded=[]
        for n in range(actual.n_frames):
            actual.seek(n);duration+=actual.info['duration'];decoded.append(actual.convert('RGB').copy())
        assert duration==N*MS and path.stat().st_size<2_000_000
        assert ImageChops.difference(decoded[0],decoded[len(decoded)//2]).getbbox()
        # Signature strip is exact and stable throughout every decoded frame.
        signature=decoded[0].crop((0,593,W,H)).tobytes()
        assert all(im.crop((0,593,W,H)).tobytes()==signature for im in decoded)
        sheet=Image.new('RGB',(W*2,H*2),BG)
        for k,idx in enumerate([0,N//4,N//2,3*N//4]):sheet.paste(decoded[min(idx,len(decoded)-1)],((k%2)*W,(k//2)*H))
        sheet.resize((1536,806),Image.Resampling.LANCZOS).save(OUT/(path.stem+'-contact.png'))
        decoded[0].save(OUT/(path.stem+'-static.png'))
    return {'file':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,
            'size':[W,H],'frames':len(decoded),'duration_ms':duration,'loop':0,'signature_each_frame_verified':True}

if __name__=='__main__':
    figures=[render('24-operator-flow-20261108.gif',architecture),render('25-shared-cases-20261108.gif',shared_cases),render('26-sandbox-receipt-20261108.gif',sandbox)]
    manifest={'author':'Francisco Angulo de Lafuente','orcid':'https://orcid.org/0009-0001-1634-7063','license':'MIT',
              'generation':'Original deterministic Pillow drawings, CPU only; no external or generated image assets.',
              'provider_attempt':{'provider':'Higgsfield','model':'gpt_image_2_6','format':'gif','submitted_jobs':0,'error':'Requires basic plan or higher.'},
              'runtime_source_commit':'6957d117881d11d308a9306dad5a14a2dd7ebf0d',
              'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'render_environment':{'Pillow':PIL.__version__,'fonts':'Windows Segoe UI, Segoe UI Semibold, Consolas; font files not redistributed'},
              'figures':figures,'all_text_inside_canvas':True}
    (OUT/'GIF_PROVENANCE.json').write_bytes((json.dumps(manifest,indent=2)+'\n').encode())
    print(json.dumps(manifest))
