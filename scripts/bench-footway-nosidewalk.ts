import { buildRoutingGraph } from '../src/services/clientRouter'
import { buildQuery } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import type { OsmWay } from '../src/utils/types'
const PROXY='https://bike-map.fryanpan.com/api/overpass', T=0.1
// Non-sidewalk: footway/pedestrian EXCEPT footway=sidewalk|crossing (Bryan's exclude-sidewalks constraint).
function q(bbox:any){const b=`${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  return buildQuery(bbox).replace(');\nout geom;',`  way["highway"~"^(footway|pedestrian)$"]["footway"!="sidewalk"]["footway"!="crossing"](${b});\n);\nout geom;`)}
async function tile(row:number,col:number):Promise<OsmWay[]>{const bbox={south:row*T,north:(row+1)*T,west:col*T,east:(col+1)*T}
  for(let a=0;a<5;a++){const r=await fetch(`${PROXY}?row=nosw-${row}&col=${col}`,{method:'POST',body:`data=${encodeURIComponent(q(bbox))}`,headers:{'Content-Type':'application/x-www-form-urlencoded'}})
    if(r.ok){const d=await r.json() as any;if(d.remark){await new Promise(s=>setTimeout(s,8000));continue}
      return (d.elements??[]).filter((e:any)=>e.type==='way'&&e.geometry).map((e:any)=>({osmId:e.id,coordinates:e.geometry.map((p:any)=>[p.lat,p.lon]),tags:e.tags??{},itemName:null}))}
    await new Promise(s=>setTimeout(s,(a+1)*4000))}
  console.warn(`${row}:${col} FAILED`);return []}
async function city(tiles:[number,number][]){const all:OsmWay[]=[];for(const[r,c]of tiles){all.push(...await tile(r,c));await new Promise(s=>setTimeout(s,2500))}return all}
function mb(n:number){return(n/1024/1024).toFixed(0)}
async function meas(label:string,ways:OsmWay[]){const fw=ways.filter(w=>w.tags.highway==='footway'||w.tags.highway==='pedestrian').length
  console.log(`\n### ${label}: ${ways.length} ways (${fw} footway/ped)`)
  for(const m of ['kid-starting-out','kid-traffic-savvy']){(globalThis as any).Bun?.gc(true);const t0=performance.now()
    const g=buildRoutingGraph(ways,m,getDefaultPreferredItems(m));console.log(`| ${m} | ${g.getNodeCount()} nodes | ${g.getLinkCount()} edges | ${(performance.now()-t0).toFixed(0)}ms | ${mb(process.memoryUsage().rss)}MB |`)}}
const SF:[number,number][]=[];for(let r=377;r<=378;r++)for(let c=-1226;c<=-1224;c++)SF.push([r,c])
console.log('SF non-sidewalk...');await meas('SF · NON-SIDEWALK footways',await city(SF))
const BE:[number,number][]=[[525,133],[525,134],[525,135]]
console.log('Berlin non-sidewalk...');await meas('Berlin(3) · NON-SIDEWALK footways',await city(BE))
console.log('done')
