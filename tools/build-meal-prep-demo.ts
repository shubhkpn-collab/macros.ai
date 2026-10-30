import {readFileSync,writeFileSync} from 'node:fs';
const rows:unknown=JSON.parse(readFileSync('data/grocery/overnight-oats-demo.json','utf8'));
if(!Array.isArray(rows)||rows.length!==18)throw Error('Expected 18 sourced demo products');
const seen=new Set<string>();
for(const row of rows){
 const v=row.version,b=v?.basis;
 if(!v||seen.has(v.productVersionId)||!v.source?.sourceId||!Number.isFinite(Date.parse(v.effectiveFrom))||b?.kind!=='per_100g'||[b.kcal,b.proteinG,b.carbohydrateG,b.fatG].some(n=>!Number.isFinite(n)||n<0)||b.kcal>1000||b.proteinG+b.carbohydrateG+b.fatG>105||!/^https:\/\/(i5.walmartimages.com|images.openfoodfacts.org)\//.test(row.image?.url??''))throw Error('Invalid sourced demo product');
 seen.add(v.productVersionId);
}
const body=rows.map(row=>JSON.stringify(row).replace(/"effectiveFrom":"([^"]+)"/,(_,date)=>`"effectiveFrom":instant("${date}")`)).join(',\n');
writeFileSync('packages/catalog-runtime/src/overnight-demo.generated.ts',`// Generated from data/grocery/overnight-oats-demo.json by tools/build-meal-prep-demo.ts.\nimport {instant,type ProductVersion} from '@macros/contracts';\nexport interface DemoFood {photoMatch:'manually_curated_variant_reference';id:string;group:string;version:ProductVersion;image:{url:string;sourceUrl:string;attribution:string;license:string};sourceUrl:string;sourceBarcode:string|null}\nexport const OVERNIGHT_DEMO:readonly DemoFood[]=[\n${body}\n];\n`);
console.log('Validated and bundled 18 sourced meal-prep choices');
