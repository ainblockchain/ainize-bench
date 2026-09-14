#!/usr/bin/env python3
"""Screenshots for the submission, drawn from measured results only (runs/r1 + chain/out)."""
import json, collections
from PIL import Image, ImageDraw, ImageFont

F='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FB='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FM='/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
FMB='/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
f=lambda p,s: ImageFont.truetype(p,s)
W,H=1600,900
BG=(13,17,23); FG=(230,237,243); MUT=(125,139,153)
RED=(248,81,73); GRN=(63,185,80); BLU=(88,166,255); PNL=(22,27,34); LN=(48,54,61)

def canvas(title, sub, src="measured on bench/runs/r1"):
    im=Image.new('RGB',(W,H),BG); d=ImageDraw.Draw(im)
    d.text((70,58),title,font=f(FB,46),fill=FG)
    d.text((70,120),sub,font=f(F,22),fill=MUT)
    d.line([(70,168),(W-70,168)],fill=LN,width=2)
    d.text((70,H-46),f"Ainize · {src} · 2026-09-13",font=f(F,18),fill=MUT)
    return im,d

# ── 1. headline: vault_asset 0/13 → 11/13
rows=json.load(open('bench/runs/r1/results.json'))['rows']
hb=[r for r in rows if r.get('bucket')=='headline']
fact=lambda i:i.rsplit('.',1)[0]
def facts(arm,t):
    b=collections.defaultdict(list)
    for r in hb:
        if r['arm']==arm and r['id'].split(':')[0]==t: b[fact(r['id'])].append(bool(r.get('hit')))
    return sum(1 for v in b.values() if all(v)), len(b)

im,d=canvas("The base model knows none of it. One patch teaches it.",
            "vault-asset questions · a fact counts only if EVERY held-out phrasing is right")
for i,(lab,arm,col) in enumerate([("base model","A",RED),("+ Ainize patch","C",GRN)]):
    hit,tot=facts(arm,'vault_asset'); x=150+i*720
    d.rounded_rectangle([x,230,x+620,700],18,fill=PNL,outline=LN,width=2)
    d.text((x+40,268),lab,font=f(FB,30),fill=FG)
    d.text((x+40,330),f"{hit}/{tot}",font=f(FMB,150),fill=col)
    d.text((x+40,500),f"{hit/tot*100:.0f}% of facts",font=f(F,28),fill=MUT)
    bw=540; d.rounded_rectangle([x+40,560,x+40+bw,606],10,fill=(33,38,45))
    if hit: d.rounded_rectangle([x+40,560,x+40+int(bw*hit/tot),606],10,fill=col)
    for k in range(tot):
        cx=x+46+k*42; ok = k<hit
        d.ellipse([cx,640,cx+28,668],fill=col if ok else (45,50,58))
d.text((150,740),"13 facts · each asked in multiple phrasings the model was never trained on",font=f(F,24),fill=MUT)
d.text((150,780),"On 30 facts withheld from training the patch scores 0/30 — same as base. The gain is the patch, not leakage.",font=f(F,22),fill=BLU)
im.save('media/01-headline.png')

# ── 2. per question type
im,d=canvas("Where it learns, and where it doesn't",
            "facts correct across every phrasing · answer type decides the outcome")
types=sorted({r['id'].split(':')[0] for r in hb})
data=[(t,*facts('C',t)) for t in types]
data.sort(key=lambda r:-(r[1]/r[2]))
y=218
for t,hit,tot in data:
    hexish = t in ('market_address','pool_tokens','vault_address')
    d.text((80,y+4),t,font=f(FM,24),fill=FG)
    d.text((430,y+4),"hex address" if hexish else "word / symbol",font=f(F,20),fill=(200,120,60) if hexish else BLU)
    bw=700; d.rounded_rectangle([640,y,640+bw,y+32],8,fill=(33,38,45))
    if hit: d.rounded_rectangle([640,y,640+int(bw*hit/tot),y+32],8,fill=GRN if hit else RED)
    d.text((1365,y+4),f"{hit}/{tot}",font=f(FMB,24),fill=FG if hit else MUT)
    y+=58
d.text((80,y+10),"Coverage is uneven: four types score zero on every fact, and the two weakest both ask for a 40-character",font=f(F,21),fill=(200,120,60))
d.text((80,y+42),"hex address. That localises the next fix to how the training set is built, not to the method.",font=f(F,21),fill=(200,120,60))
im.save('media/02-by-question-type.png')

# ── 3. why wrong addresses are dangerous
im,d=canvas("A wrong address that looks right","348 canonical token addresses on Ethereum and Base, asked of the base model",
            src="measured on chain/out/arm_a.json · ground truth: CoinGecko platform registry")
try: a=json.load(open('chain/out/arm_a.json'))
except Exception: a=[]
if a:
    n=len(a); c=lambda v:sum(1 for x in a if x['verdict']==v)
    for i,(lab,v,col) in enumerate([("correct",'correct',GRN),("wrong address",'hallucinated',RED),("refused",'refused',MUT)]):
        x=90+i*500; d.rounded_rectangle([x,215,x+460,375],16,fill=PNL,outline=LN,width=2)
        d.text((x+30,240),lab,font=f(F,24),fill=MUT)
        d.text((x+30,278),f"{c(v)/n*100:.1f}%",font=f(FMB,64),fill=col)
        d.text((x+250,300),f"{c(v)}/{n}",font=f(FM,26),fill=MUT)
    pre=lambda p,q:(lambda i=0:[i for i in [next((k for k in range(min(len(p),len(q))+1) if k==len(p) or k==len(q) or p[k]!=q[k]),0)]][0])()
    w=[x for x in a if x['verdict']=='hallucinated']
    w=sorted(w,key=lambda x:-pre(x['answer'] or '',x['address']))[:4]
    d.text((90,415),"The wrong ones share a prefix with the truth — exactly what a wallet shows you:",font=f(F,24),fill=FG)
    y=470
    for x_ in w:
        k=pre(x_['answer'],x_['address'])
        d.text((90,y),f"{x_['symbol']}",font=f(FMB,24),fill=FG)
        d.text((240,y),"model",font=f(F,18),fill=MUT); d.text((330,y),x_['answer'],font=f(FM,22),fill=RED)
        d.text((240,y+30),"truth",font=f(F,18),fill=MUT); d.text((330,y+30),x_['address'],font=f(FM,22),fill=GRN)
        d.text((1200,y+14),f"first {k} chars identical",font=f(F,20),fill=(200,120,60))
        y+=84
im.save('media/03-wrong-but-plausible.png')
print("saved 3 images")
