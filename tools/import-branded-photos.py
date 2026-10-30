"""Join official Open Food Facts TSV export to USDA by exact GTIN. Images remain remote; no image scraping."""
import csv,gzip,hashlib,json,os,re,sqlite3,sys,time
from collections import Counter
csv.field_size_limit(16*1024*1024)
source=sys.argv[1]
foods=sqlite3.connect('file:data/runtime/branded-foods.sqlite?mode=ro',uri=True)
barcodes={row[0] for row in foods.execute('SELECT barcode FROM products')}
photos=sqlite3.connect('data/runtime/branded-photos.sqlite')
photos.execute('CREATE TABLE IF NOT EXISTS photos (barcode TEXT PRIMARY KEY,image TEXT,checked INTEGER NOT NULL)')
counts=Counter();batch=[]
url_pattern=re.compile(r'^https://images\.openfoodfacts\.org/images/products/[0-9/]+/[a-z0-9_.-]+\.jpg$')
with gzip.open(source,'rt',encoding='utf-8',newline='') as stream:
 reader=csv.DictReader(stream,delimiter='\t')
 if not {'code','image_url'}.issubset(reader.fieldnames or []):raise ValueError('Export missing barcode/front-image fields')
 for row in reader:
  counts['rowsRead']+=1
  code=row.get('code','').strip()
  if not code.isdigit() or len(code) not in (8,12,13,14):continue
  gtin=code.zfill(14)
  if gtin not in barcodes:continue
  counts['barcodeMatches']+=1
  image=row.get('image_url','').strip()
  if not image:counts['missingImage']+=1;continue
  if not url_pattern.fullmatch(image):counts['rejectedImageUrl']+=1;continue
  # Keep image identity tied to the source product barcode, never its name.
  facts={'url':image,'sourceUrl':'https://world.openfoodfacts.org/product/'+code,'attribution':'Photo: Open Food Facts contributors','license':'CC-BY-SA-3.0'}
  batch.append((gtin,json.dumps(facts,separators=(',',':')),int(time.time()*1000)))
  counts['matchedPhotoRows']+=1
  if len(batch)>=1000:
   photos.executemany('INSERT OR REPLACE INTO photos VALUES (?,?,?)',batch);photos.commit();batch=[]
  if counts['rowsRead']%500000==0:print(json.dumps(dict(counts)),flush=True)
photos.executemany('INSERT OR REPLACE INTO photos VALUES (?,?,?)',batch);photos.commit()
matched=int(photos.execute('SELECT count(*) FROM photos WHERE image IS NOT NULL').fetchone()[0])
sha=hashlib.sha256()
with open(source,'rb') as stream:
 for chunk in iter(lambda:stream.read(1024*1024),b''):sha.update(chunk)
report={'source':'Open Food Facts official TSV export','sourceUrl':'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz','exportSha256':sha.hexdigest(),'databaseLicense':'ODbL-1.0','imageLicense':'CC-BY-SA-3.0','counts':dict(counts),'catalogProducts':len(barcodes),'photoMetadataRecords':matched,'photoCoveragePercent':round(100*matched/len(barcodes),2),'imageFilesDownloaded':0,'limitations':['Exact barcode match is product identity evidence, not a manual visual review','Image URLs can expire or packages can change','Missing photos remain labeled illustrations','No retailer inventory verified']}
os.makedirs('data/grocery',exist_ok=True)
with open('data/grocery/branded-photo-report.json','w') as f:json.dump(report,f,indent=2);f.write('\n')
# Separate reusable photo-metadata export, with source/license, for attribution/share-alike distribution.
with gzip.open('data/runtime/branded-photo-metadata.ndjson.gz','wt',encoding='utf-8') as f:
 for barcode,image in photos.execute('SELECT barcode,image FROM photos WHERE image IS NOT NULL ORDER BY barcode'):
  f.write(json.dumps({'barcode':barcode,'image':json.loads(image),'databaseLicense':'ODbL-1.0'})+'\n')
photos.close();foods.close();print(json.dumps(report),flush=True)
