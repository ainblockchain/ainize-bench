const RPC="https://ethereum-rpc.publicnode.com";
let id=0;
async function rpc(m,p){const r=await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:++id,method:m,params:p})});return await r.json();}
async function call(to,data){const j=await rpc("eth_call",[{to,data},"latest"]);return j.error?null:j.result;}
function decStr(hex){if(!hex||hex==="0x")return null;const b=hex.slice(2);
 if(b.length>=128){const len=parseInt(b.slice(64,128),16);
  if(len>0&&len<200&&b.length>=128+len*2){const s=Buffer.from(b.slice(128,128+len*2),"hex").toString("utf8");if(/^[\x20-\x7e]+$/.test(s))return s;}}
 const s2=Buffer.from(b.slice(0,64),"hex").toString("utf8").replace(/\0+$/,"");return /^[\x20-\x7e]+$/.test(s2)&&s2.length?s2:null;}
function decAddr(h){if(!h||h.length<66)return null;const a="0x"+h.slice(-40);return a==="0x"+"0".repeat(40)?null:a;}

// discovery source: Morpho public API (no key). Ground truth: on-chain eth_call.
const q=`{ vaults(first: 30, where: {chainId_in: [1]}, orderBy: TotalAssetsUsd, orderDirection: Desc) { items { address symbol name asset { address symbol } state { totalAssetsUsd } } } }`;
const r=await fetch("https://blue-api.morpho.org/graphql",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:q})});
const items=(await r.json()).data.vaults.items;
console.log("discovery returned", items.length, "candidate vaults\n");

const verified=[];
for(const v of items){
  const a=v.address;
  const onSym=decStr(await call(a,"0x95d89b41"));
  const onName=decStr(await call(a,"0x06fdde03"));
  const onAsset=decAddr(await call(a,"0x38d52e0f"));
  if(!onAsset){console.log(`SKIP ${a} asset() reverted`);continue;}
  const onAssetSym=decStr(await call(onAsset,"0x95d89b41"));
  const taRaw=await call(a,"0x01e1d114");
  const match = onSym===v.symbol && onAsset.toLowerCase()===v.asset.address.toLowerCase();
  verified.push({address:a,symbol:onSym,name:onName,asset:onAsset,assetSymbol:onAssetSym,
    totalAssets: taRaw&&taRaw!=="0x"?BigInt(taRaw).toString():null, apiAgrees:match});
  console.log(`${a}\n  onchain symbol=${onSym}  name=${onName}\n  onchain asset=${onAsset} (${onAssetSym})  api-agrees=${match}`);
}
const fs=await import("fs");
const blk=parseInt((await rpc("eth_blockNumber",[])).result,16);
fs.writeFileSync(D+"/vaults-onchain-block25902775.json",JSON.stringify({block:blk,chain:"ethereum-mainnet",verified},null,2));
console.log(`\nVERIFIED ON-CHAIN: ${verified.length} vaults at block ${blk}; api-agrees on ${verified.filter(v=>v.apiAgrees).length}`);
