import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
export const dataDir=resolve(process.env.DATA_DIR||'./data');
mkdirSync(join(dataDir,'recordings'),{recursive:true});
export const sqlite=new DatabaseSync(join(dataDir,'examflow.sqlite'));
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS applied_migrations(name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,account TEXT NOT NULL,expires INTEGER NOT NULL);');
for(const name of readdirSync('../drizzle').filter(x=>x.endsWith('.sql')).sort()){
 if(!sqlite.prepare('SELECT name FROM applied_migrations WHERE name=?').get(name)){
 sqlite.exec('BEGIN');try{sqlite.exec(readFileSync('../drizzle/'+name,'utf8').replaceAll('--> statement-breakpoint',''));sqlite.prepare('INSERT INTO applied_migrations VALUES(?)').run(name);sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}
 }
}
export const hash=x=>createHash('sha256').update(x).digest('hex');
export async function getUser(r){if(process.env.LOCAL_PREVIEW==='1')return {userId:'local_teacher',displayName:'อาจารย์ (ทดลองในเครื่อง)',email:'local@example.test'};const token=r.headers.get('cookie')?.match(/(?:^|;\s*)examflow_session=([a-f0-9]{64})(?:;|$)/)?.[1];if(!token)return null;const a=sqlite.prepare('SELECT a.* FROM accounts a JOIN sessions s ON a.id=s.account WHERE s.token=? AND s.expires>?').get(hash(token),Date.now());return a?{userId:a.id,displayName:a.name,email:a.email}:null;}
function recordingPath(key){if(!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key))throw Error('Invalid recording key');return join(dataDir,'recordings',key);}
export const env={DB:{prepare(sql){return {bind(...args){const s=sqlite.prepare(sql);return {async first(){return s.get(...args)||null},async all(){return {results:s.all(...args)}},async run(){return s.run(...args)}}}}}},BUCKET:{async put(key,data,options){const p=recordingPath(key);mkdirSync(resolve(p,'..'),{recursive:true});writeFileSync(p,Buffer.from(data));writeFileSync(p+'.type',options.httpMetadata.contentType);},async get(key){const p=recordingPath(key);if(!existsSync(p))return null;return {body:readFileSync(p),httpMetadata:{contentType:readFileSync(p+'.type','utf8')}}}}};

