import fs from "fs";
import { buildSchema, parse, validate, specifiedRules } from "graphql";
const SDL_PRELUDE = `
scalar BigInt
scalar BigDecimal
scalar Bytes
scalar Int8
scalar Timestamp
directive @entity(immutable: Boolean, timeseries: Boolean) on OBJECT
directive @derivedFrom(field: String!) on FIELD_DEFINITION
directive @regularPolling on OBJECT
directive @transaction on OBJECT
directive @aggregate(fn: String, arg: String, cumulative: Boolean) on FIELD_DEFINITION
directive @snapshot on OBJECT
directive @dailySnapshot on OBJECT
directive @hourlySnapshot on OBJECT
directive @aggregation(intervals: [String!], source: String) on OBJECT
directive @subgraphId(id: String!) on OBJECT
type _Block_ { number: Int! hash: Bytes timestamp: Int }
type _Meta_ { block: _Block_! deployment: String! hasIndexingErrors: Boolean! }
`;
// graph-node auto-generates a root Query with plural/singular fields per entity.
function autoQuery(sdl) {
  const names = [...sdl.matchAll(/^type\s+([A-Za-z0-9_]+)\s+(?:implements\s+[A-Za-z0-9_\s&]+\s+)?@entity/gm)].map(m=>m[1]);
  const ifaces = [...sdl.matchAll(/^interface\s+([A-Za-z0-9_]+)/gm)].map(m=>m[1]);
  const all=[...new Set([...names,...ifaces])];
  // graph-node generates a per-entity orderBy enum from that entity's own fields
  const fieldsOf = (n) => {
    const m = sdl.match(new RegExp("^(?:type|interface)\\s+"+n+"\\b[^{]*\\{([\\s\\S]*?)^\\}", "m"));
    if (!m) return ["id"];
    const fs = [...m[1].matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map(x=>x[1]);
    return fs.length ? [...new Set(fs)] : ["id"];
  };
  const f = all.map(n=>{
    const lower = n[0].toLowerCase()+n.slice(1);
    return `  ${lower}(id: ID!, block: Block_height): ${n}\n  ${lower}s(first: Int, skip: Int, orderBy: ${n}_orderBy, orderDirection: OrderDirection, where: ${n}_filter, block: Block_height): [${n}!]!`;
  }).join("\n");
  const filters = all.map(n=>`input ${n}_filter { id: ID }\nenum ${n}_orderBy { ${fieldsOf(n).join(" ")} }`).join("\n");
  return `${sdl}\n${SDL_PRELUDE}\ninput Block_height { number: Int hash: Bytes }\nenum OrderDirection { asc desc }\n${filters}\ntype Query {\n${f}\n  _meta(block: Block_height): _Meta_\n}\n`;
}
const target = process.argv[2], qfile = process.argv[3];
let sdl = fs.readFileSync(target,"utf8");
const schema = buildSchema(autoQuery(sdl));
const doc = parse(fs.readFileSync(qfile,"utf8"));
const errs = validate(schema, doc, specifiedRules);
console.log(`${target.padEnd(26)} vs ${qfile}:`);
if (!errs.length) console.log("  VALID — query type-checks against this schema\n");
else { for (const e of errs) console.log("  ERROR:", e.message); console.log(); }
