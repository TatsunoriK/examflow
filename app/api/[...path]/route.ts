import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
export const dynamic='force-dynamic';
const json=(x:any,s=200)=>Response.json(x,{status:s,headers:{'Cache-Control':'no-store'}});
export async function GET(r:Request){return handle(r)}
export async function POST(r:Request){return handle(r)}
async function handle(r:Request){try{
 const u=await getChatGPTUser(); if(!u)return json({error:'กรุณาเข้าสู่ระบบก่อนใช้งาน'},401);
 const db=env.DB!; const p=new URL(r.url).pathname.split('/').filter(Boolean).slice(1); const now=Date.now();
 if(p[0]==='me')return json({name:u.displayName});
 if(p[0]==='exams'&&r.method==='GET'){
 const rows=await db.prepare('SELECT * FROM exams WHERE owner=? ORDER BY created DESC').bind(u.userId).all();return json(rows.results.map((x:any)=>({...x,...JSON.parse(x.body),body:undefined})));}
 if(p[0]==='exams'&&r.method==='POST'){
 const b:any=await r.json();if(!b.title?.trim()||b.title.length>200||!Number.isInteger(b.minutes)||b.minutes<1||b.minutes>180||!Array.isArray(b.questions)||b.questions.length<1||b.questions.length>100||b.questions.some((q:any)=>!q.text?.trim()||q.text.length>3000||!Array.isArray(q.options)||q.options.length!==4||q.options.some((v:any)=>typeof v!=='string'||!v.trim()||v.length>1000)||!Number.isInteger(q.correct)||q.correct<0||q.correct>3))return json({error:'ตรวจสอบชื่อข้อสอบ เวลา และตัวเลือกให้ครบ'},400);
 const id=crypto.randomUUID(),code=crypto.randomUUID().replaceAll('-','').slice(0,10).toUpperCase();await db.prepare('INSERT INTO exams(id,owner,code,body,created) VALUES(?,?,?,?,?)').bind(id,u.userId,code,JSON.stringify({title:b.title,subject:b.subject||'ทั่วไป',minutes:b.minutes,questions:b.questions}),now).run();return json({id,code});}
 if(p[0]==='join'){
 const b:any=await r.json();const e:any=await db.prepare('SELECT * FROM exams WHERE code=?').bind(String(b.code).trim().toUpperCase()).first();if(!e)return json({error:'ไม่พบรหัสข้อสอบนี้'},404);const body=JSON.parse(e.body);return json({id:e.id,title:body.title,minutes:body.minutes,count:body.questions.length});}
 if(p[0]==='start'){
 const b:any=await r.json();if(!b.name?.trim()||b.name.length>120)return json({error:'กรอกชื่อผู้สอบ'},400);const e:any=await db.prepare('SELECT * FROM exams WHERE id=?').bind(b.exam).first();if(!e)return json({error:'ไม่พบข้อสอบ'},404);
 let a:any=await db.prepare('SELECT * FROM attempts WHERE exam=? AND student=? ORDER BY started DESC LIMIT 1').bind(e.id,u.userId).first();if(a?.submitted)return json({error:'คุณส่งข้อสอบนี้แล้ว'},409);if(!a){const id=crypto.randomUUID();await db.prepare('INSERT INTO attempts(id,exam,student,name,started) VALUES(?,?,?,?,?)').bind(id,e.id,u.userId,b.name.trim(),now).run();a={id,started:now,answers:'{}'};}const body=JSON.parse(e.body);return json({id:a.id,deadline:a.started+body.minutes*60000,answers:JSON.parse(a.answers),questions:body.questions.map(({correct,...q}:any)=>q)});}
 if(p[0]==='results'){
 const e:any=await db.prepare('SELECT * FROM exams WHERE id=? AND owner=?').bind(p[1],u.userId).first();if(!e)return json({error:'ไม่มีสิทธิ์'},403);const rows=await db.prepare('SELECT * FROM attempts WHERE exam=? ORDER BY started DESC').bind(e.id).all();return json(rows.results.map((a:any)=>({...a,events:JSON.parse(a.events),recordings:JSON.parse(a.recordings),answers:undefined,student:undefined})));}
 if(p[0]==='video'){
 const a:any=await db.prepare('SELECT a.* FROM attempts a JOIN exams e ON e.id=a.exam WHERE a.id=? AND e.owner=?').bind(p[1],u.userId).first();if(!a)return json({error:'ไม่มีสิทธิ์'},403);const key=JSON.parse(a.recordings)[Number(p[2])];if(!key)return json({error:'ไม่พบวิดีโอ'},404);const obj=await env.BUCKET!.get(key);if(!obj)return json({error:'ไม่พบวิดีโอ'},404);return new Response(obj.body,{headers:{'Content-Type':obj.httpMetadata?.contentType||'video/webm','Cache-Control':'private, no-store'}});}
 if(p[0]==='attempt'){
 const a:any=await db.prepare('SELECT * FROM attempts WHERE id=? AND student=?').bind(p[1],u.userId).first();if(!a)return json({error:'ไม่มีสิทธิ์'},403);if(a.submitted)return json({error:'ส่งข้อสอบแล้ว'},409);
 const e:any=await db.prepare('SELECT * FROM exams WHERE id=?').bind(a.exam).first();const exam=JSON.parse(e.body);const deadline=a.started+exam.minutes*60000;
 if(p[2]==='record'){
 const size=Number(r.headers.get('content-length')||0);if(size>20*1024*1024)return json({error:'ไฟล์ใหญ่เกินไป'},413);const data=await r.arrayBuffer();if(!data.byteLength||data.byteLength>20*1024*1024)return json({error:'ขนาดไฟล์ไม่ถูกต้อง'},400);const type=r.headers.get('content-type')||'';if(!/^video\/(webm|mp4)/.test(type))return json({error:'ชนิดไฟล์ไม่รองรับ'},400);const key=a.id+'/'+crypto.randomUUID();await env.BUCKET!.put(key,data,{httpMetadata:{contentType:type}});await db.prepare("UPDATE attempts SET recordings=json_insert(recordings,'$[#]',?) WHERE id=?").bind(key,a.id).run();return json({ok:true});}
 const b:any=await r.json();
 if(p[2]==='event'){const type=String(b.type).slice(0,120);await db.prepare("UPDATE attempts SET events=json_insert(events,'$[#]',json(?)) WHERE id=? AND json_array_length(events)<2000").bind(JSON.stringify({type,time:now}),a.id).run();return json({ok:true});}
 if(p[2]==='answers'){if(now>deadline)return json({error:'หมดเวลาสอบแล้ว'},409);const answers=b.answers||{};if(Object.entries(answers).some(([k,v])=>!/^\d+$/.test(k)||Number(k)>=exam.questions.length||!Number.isInteger(v)||Number(v)<0||Number(v)>3))return json({error:'คำตอบไม่ถูกต้อง'},400);await db.prepare('UPDATE attempts SET answers=? WHERE id=?').bind(JSON.stringify(answers),a.id).run();return json({ok:true});}
 if(p[2]==='submit'){if(!JSON.parse(a.recordings).length)return json({error:'กรุณารออัปโหลดบันทึกหน้าจอก่อนส่ง'},400);const answers=JSON.parse(a.answers);const score=exam.questions.reduce((s:number,q:any,i:number)=>s+(answers[i]===q.correct?1:0),0);await db.prepare('UPDATE attempts SET submitted=?,score=? WHERE id=?').bind(now,score,a.id).run();return json({score,total:exam.questions.length});}
 }
 return json({error:'ไม่พบรายการ'},404);
}catch(e){console.error(e);return json({error:'ระบบขัดข้อง กรุณาลองอีกครั้ง'},500)}}
