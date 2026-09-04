const RPC="https://ethereum-rpc.publicnode.com";
let id=0;
async function rpc(m,p){const r=await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:++id,method:m,params:p})});return await r.json();}
const IDR="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", REP="0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
for(const [n,a] of [["IdentityRegistry",IDR],["ReputationRegistry",REP]]){
  const code=(await rpc("eth_getCode",[a,"latest"])).result;
  console.log(`${n} ${a} -> bytecode ${code&&code!=="0x"?(code.length-2)/2+" bytes DEPLOYED":"NO CODE"}`);
}
// ERC-721 style name() on identity registry
const nm=(await rpc("eth_call",[{to:IDR,data:"0x06fdde03"},"latest"])).result;
if(nm&&nm!=="0x"){const b=nm.slice(2);const len=parseInt(b.slice(64,128),16);
 console.log("IdentityRegistry name():",Buffer.from(b.slice(128,128+len*2),"hex").toString("utf8"));}

const URL="http://localhost:8002/v1/chat/completions";
async function ask(q){const r=await fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},
 body:JSON.stringify({model:"Qwen3.8-Flash-Next",messages:[{role:"user",content:q}],max_tokens:60,temperature:0,chat_template_kwargs:{enable_thinking:false}})});
 const j=await r.json();return (j.choices?.[0]?.message?.content||"").trim();}

const qs=[
 {q:"What is the contract address of the ERC-8004 IdentityRegistry on Ethereum mainnet? Reply with the 0x address only.",truth:IDR},
 {q:"What is the contract address of the ERC-8004 ReputationRegistry on Ethereum mainnet? Reply with the 0x address only.",truth:REP},
 {q:"What is the contract address of the ERC-8004 IdentityRegistry on Base mainnet? Reply with the 0x address only.",truth:IDR},
 {q:"What is the contract address of the ERC-8004 IdentityRegistry on Polygon mainnet? Reply with the 0x address only.",truth:IDR},
 {q:"What is the contract address of the ERC-8004 IdentityRegistry on BNB Smart Chain (BSC) mainnet? Reply with the 0x address only.",truth:IDR},
];
console.log("\n=== F5 ERC-8004 registry address (ground truth = agent0 subgraph manifests, code verified on-chain) ===");
let ok=0,ref=0;
for(const t of qs){
  const a=await ask(t.q);
  const correct=a.toLowerCase().includes(t.truth.toLowerCase());
  const refuse=/(do not have|don't have|do not know|don't know|cannot|can't|unable|not publicly|no public|not aware|i'm not)/i.test(a);
  if(correct)ok++; if(refuse)ref++;
  console.log(`  truth=${t.truth}\n    said="${a.replace(/\s+/g," ").slice(0,80)}" ${correct?"OK":(refuse?"refused":"WRONG-CONFIDENT")}`);
}
console.log(`  -> ${ok}/${qs.length} correct, ${ref} refused, ${qs.length-ok-ref} confidently wrong`);
