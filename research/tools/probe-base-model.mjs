import fs from "fs";
const D=new URL("../evidence", import.meta.url).pathname;
const {block, verified}=JSON.parse(fs.readFileSync(D+"/vaults-onchain-block25902775.json"));
const MODEL="Qwen3.8-Flash-Next", URL="http://localhost:8002/v1/chat/completions";
async function ask(q,think=false){
  const t0=Date.now();
  const body={model:MODEL,messages:[{role:"user",content:q}],max_tokens:think?700:60,temperature:0};
  if(!think) body.chat_template_kwargs={enable_thinking:false};
  const r=await fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json(); const m=j.choices?.[0]?.message||{};
  return {text:(m.content||"").trim(), ms:Date.now()-t0, inTok:j.usage?.prompt_tokens||0, outTok:j.usage?.completion_tokens||0};
}
const V=verified.slice(0,12);
const fams=[
 {id:"F1", name:"vault ADDRESS -> vault symbol (no leak)", leak:false,
  items:V.map(v=>({q:`On Ethereum mainnet, what is the ERC-20 token symbol of the ERC-4626 vault at contract address ${v.address}? Reply with the symbol only.`,truth:v.symbol,
   check:(a,t)=>a.toLowerCase().replace(/[^a-z0-9]/g,"").includes(t.toLowerCase().replace(/[^a-z0-9]/g,""))}))},
 {id:"F2", name:"vault ADDRESS -> underlying asset symbol (no leak)", leak:false,
  items:V.map(v=>({q:`On Ethereum mainnet, the ERC-4626 vault at contract address ${v.address} has exactly one underlying asset (its asset()). What is that asset's token symbol? Reply with the symbol only.`,truth:v.assetSymbol,
   check:(a,t)=>a.toUpperCase().includes(t.toUpperCase())}))},
 {id:"F3", name:"vault NAME -> vault contract address (no leak)", leak:false,
  items:V.map(v=>({q:`On Ethereum mainnet, what is the contract address of the ERC-4626 vault named "${v.name}"? Reply with the 0x address only.`,truth:v.address,
   check:(a,t)=>a.toLowerCase().includes(t.toLowerCase())}))},
 {id:"F4", name:"vault NAME -> underlying asset symbol (LEAKY control)", leak:true,
  items:V.map(v=>({q:`On Ethereum mainnet, the ERC-4626 vault named "${v.name}" has one underlying asset. What is its token symbol? Reply with the symbol only.`,truth:v.assetSymbol,
   check:(a,t)=>a.toUpperCase().includes(t.toUpperCase())}))},
];
const out={block,generatedAt:new Date().toISOString(),model:MODEL,thinking:false,families:[]};
for(const f of fams){
  let ok=0,refused=0,cwa=0; const lat=[],intok=[],outtok=[],recs=[];
  for(const it of f.items){
    const r=await ask(it.q);
    const correct=it.check(r.text,it.truth);
    const refuse=/(do not have|don't have|do not know|don't know|cannot|can't|unable|no public|not publicly|i'm not|not aware)/i.test(r.text);
    const said0x=/0x[0-9a-fA-F]{40}/.test(r.text);
    if(correct)ok++; if(refuse)refused++; if(!correct&&!refuse)cwa++;
    lat.push(r.ms);intok.push(r.inTok);outtok.push(r.outTok);
    recs.push({truth:it.truth,answer:r.text.replace(/\s+/g," ").slice(0,120),correct,refused:refuse,said0x});
  }
  const n=f.items.length;
  const rec={id:f.id,family:f.name,leakyControl:f.leak,n,correct:ok,accuracy:+(ok/n*100).toFixed(1),
    refused,confidentlyWrong:cwa,confidentlyWrongPct:+(cwa/n*100).toFixed(1),
    medianMs:[...lat].sort((a,b)=>a-b)[Math.floor(n/2)],
    meanInputTokens:Math.round(intok.reduce((a,b)=>a+b,0)/n),
    meanOutputTokens:Math.round(outtok.reduce((a,b)=>a+b,0)/n),records:recs};
  out.families.push(rec);
  console.log(`\n### ${f.id} ${f.name}${f.leak?"  [CONTROL]":""}`);
  console.log(`  accuracy ${ok}/${n} = ${rec.accuracy}%  |  refused ${refused}  |  CONFIDENTLY WRONG ${cwa} (${rec.confidentlyWrongPct}%)  |  ${rec.medianMs}ms  |  in~${rec.meanInputTokens}tok`);
  for(const r of recs.slice(0,5)) console.log(`   truth=${String(r.truth).slice(0,46).padEnd(46)} said="${r.answer.slice(0,60)}" ${r.correct?"OK":(r.refused?"refused":"WRONG-CONFIDENT")}`);
}
fs.writeFileSync(D+"/base-model-probe.json",JSON.stringify(out,null,2));
console.log("\nwrote probe-results.json");
