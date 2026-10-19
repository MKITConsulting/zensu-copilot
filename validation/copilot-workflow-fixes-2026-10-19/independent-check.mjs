import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const root = dirname(fileURLToPath(import.meta.url));
const entry = process.argv[2] || `${root}/project/dist/index.js`;
const cli = process.argv[3] || `${root}/project/dist/cli.js`;
const { quoteInvoice, formatCents } = await import(pathToFileURL(entry));
const checks = [];
function check(name, action) { try { action(); checks.push({name, status:'pass'}); } catch(error) { checks.push({name,status:'fail',error:error.message}); } }
check('specified invoice', () => assert.deepEqual(quoteInvoice([{unitPriceCents:1999,quantity:2},{unitPriceCents:501,quantity:1}],1250),{subtotalCents:4499,discountCents:562,totalCents:3937}));
check('half-up rounding', () => assert.deepEqual(quoteInvoice([{unitPriceCents:1,quantity:1}],5000),{subtotalCents:1,discountCents:1,totalCents:0}));
check('empty items and zero discount default', () => assert.deepEqual(quoteInvoice([]),{subtotalCents:0,discountCents:0,totalCents:0}));
check('frozen inputs unchanged', () => { const item=Object.freeze({unitPriceCents:80,quantity:3});const items=Object.freeze([item]);assert.equal(quoteInvoice(items).totalCents,240);assert.deepEqual(items,[{unitPriceCents:80,quantity:3}]); });
check('exact maximum safe subtotal', () => {const n=Number.MAX_SAFE_INTEGER;const d=Number((BigInt(n)*5000n+5000n)/10000n);assert.deepEqual(quoteInvoice([{unitPriceCents:n,quantity:1}],5000),{subtotalCents:n,discountCents:d,totalCents:n-d});});
check('subtotal overflow rejected', () => assert.throws(()=>quoteInvoice([{unitPriceCents:Number.MAX_SAFE_INTEGER,quantity:2}])));
check('sum overflow rejected', () => assert.throws(()=>quoteInvoice([{unitPriceCents:Number.MAX_SAFE_INTEGER,quantity:1},{unitPriceCents:1,quantity:1}])));
check('invalid items rejected', () => {for(const v of [null,undefined,{},'x',[null],[{}],[{unitPriceCents:1,quantity:0}],[{unitPriceCents:-1,quantity:1}],[{unitPriceCents:1.1,quantity:1}],[{unitPriceCents:1,quantity:1.1}],[{unitPriceCents:Infinity,quantity:1}],[{unitPriceCents:1,quantity:NaN}],[{unitPriceCents:2**53,quantity:1}]]) assert.throws(()=>quoteInvoice(v));});
check('invalid discounts rejected', () => {for(const v of [null,-1,10001,0.5,NaN,Infinity,'10']) assert.throws(()=>quoteInvoice([],v));});
check('200 seeded exact arithmetic samples',()=>{let s=318192;for(let i=0;i<200;i++){s=(Math.imul(s,1664525)+1013904223)>>>0;const price=s;const quantity=(s%17)+1;const bps=s%10001;const subtotal=BigInt(price)*BigInt(quantity);const discount=(subtotal*BigInt(bps)+5000n)/10000n;assert.deepEqual(quoteInvoice([{unitPriceCents:price,quantity}],bps),{subtotalCents:Number(subtotal),discountCents:Number(discount),totalCents:Number(subtotal-discount)});}});
check('existing formatter preserved',()=>assert.equal(formatCents(1234),'12.34'));
function run(input) {return spawnSync(process.execPath,[cli],{input,encoding:'utf8'});}
check('CLI exact output',()=>{const r=run('{"items":[{"unitPriceCents":1999,"quantity":2},{"unitPriceCents":501,"quantity":1}],"discountBps":1250}');assert.equal(r.status,0);assert.equal(r.stderr,'');assert.equal(r.stdout,'{"subtotalCents":4499,"discountCents":562,"totalCents":3937}\n');});
check('CLI default discount',()=>{const r=run('{"items":[]}');assert.equal(r.status,0);assert.equal(r.stderr,'');assert.deepEqual(JSON.parse(r.stdout),{subtotalCents:0,discountCents:0,totalCents:0});});
check('CLI error contract',()=>{for(const input of ['{','null','[]','{}','{"items":null}','{"items":[],"discountBps":null}','{"items":[],"discountBps":10001}']){const r=run(input);assert.equal(r.status,2,input);assert.equal(r.stdout,'',input);assert.match(r.stderr,/\S/);assert.doesNotMatch(r.stderr,/\n\s+at\s/);}});
check('CLI accepts exactly one MiB',()=>{const input='{"items":[]}'.padEnd(1024*1024,' ');const r=run(input);assert.equal(r.status,0);assert.equal(r.stderr,'');assert.deepEqual(JSON.parse(r.stdout),{subtotalCents:0,discountCents:0,totalCents:0});});
check('CLI rejects one byte over one MiB',()=>{const input='{"items":[]}'.padEnd(1024*1024+1,' ');const r=run(input);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.match(r.stderr,/input exceeds maximum of 1048576 bytes/);assert.doesNotMatch(r.stderr,/\n\s+at\s/);});
// Preserve the previous run's two one-MiB regression checks separately from the original four ACs.
for (const item of checks) item.scope = item.name.includes('one MiB') ? 'prior-implementation-regression' : 'original-invoice-acceptance';
const required = checks.filter(item => item.scope === 'original-invoice-acceptance');
const comparison = checks.filter(item => item.scope === 'prior-implementation-regression');
const result = {
  status: required.every(item => item.status === 'pass') ? 'pass' : 'fail',
  priorImplementationComparison: comparison.every(item => item.status === 'pass') ? 'pass' : 'different',
  entry, cli, checks,
};
writeFileSync(`${root}/independent-check.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === 'pass' ? 0 : 1;
