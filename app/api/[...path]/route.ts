import { env } from 'cloudflare:workers';
export const dynamic='force-dynamic';
type ReviewFlag={time_s:number;label:'suspicious'|'cheating';confidence:number};
type CameraAnalysis={status:string;reviewFlags:ReviewFlag[];modelVersion?:string;framesAnalyzed?:number};
const json=(x:unknown,s=200)=>Response.json(x,{status:s,headers:{'Cache-Control':'no-store'}});
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
function isUnknownArray(value:unknown):value is unknown[]{return Array.isArray(value)}
function isReviewLabel(value:unknown):value is ReviewFlag['label']{return value==='suspicious'||value==='cheating'}
async function analyzeCamera(data:ArrayBuffer,type:string):Promise<CameraAnalysis>{
 if(!env.PROCTORING_API_URL)return {status:'not_configured',reviewFlags:[]};
 if(!env.PROCTORING_API_TOKEN)return {status:'configuration_error',reviewFlags:[]};
 try{
 const endpoint=new URL('/analyze',env.PROCTORING_API_URL);
 if(endpoint.protocol!=='https:'&&endpoint.hostname!=='localhost'&&endpoint.hostname!=='127.0.0.1')return {status:'configuration_error',reviewFlags:[]};
 const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.PROCTORING_API_TOKEN}`,'Content-Type':type},body:data});
 if(!response.ok)return {status:response.status===503?'model_unavailable':'analysis_failed',reviewFlags:[]};
 const result:unknown=await response.json();
 if(!isRecord(result)||result.status!=='analyzed'||!isUnknownArray(result.review_flags))return {status:'invalid_response',reviewFlags:[]};
 const reviewFlags=result.review_flags.slice(0,20).flatMap((value:unknown):ReviewFlag[]=>{
  if(!isRecord(value)||typeof value.time_s!=='number'||!Number.isFinite(value.time_s)||value.time_s<0||value.time_s>30||!isReviewLabel(value.label)||typeof value.confidence!=='number'||!Number.isFinite(value.confidence))return [];
  return [{time_s:value.time_s,label:value.label,confidence:Math.min(1,Math.max(0,value.confidence))}];
 });
 return {status:'analyzed',modelVersion:typeof result.model_version==='string'?result.model_version.slice(0,80):'unknown',framesAnalyzed:typeof result.frames_analyzed==='number'&&Number.isInteger(result.frames_analyzed)?result.frames_analyzed:0,reviewFlags};
 }catch(error){console.error('Proctoring service request failed',error);return {status:'analysis_failed',reviewFlags:[]};}
}
export async function GET(r:Request){return handle(r)}
export async function POST(r:Request){return handle(r)}
const toHex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
async function digest(value:string){return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))}
async function passwordHash(password:string,salt:string){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(salt),iterations:210000},key,256);return toHex(new Uint8Array(bits))}
function cookieToken(r:Request){return (r.headers.get('cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('examflow_session='))?.slice('examflow_session='.length)||''}
async function getAccountUser(r:Request,db:any){const token=cookieToken(r);if(!token)return null;const row:any=await db.prepare('SELECT u.id,u.name,u.email,u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await digest(token),Date.now()).first();return row?{userId:row.id,displayName:row.name,email:row.email,fullName:row.name,role:row.role}:null}
async function authRequest(r:Request,action:string|undefined,db:any){
 const b:any=await r.json().catch(()=>({}));const email=typeof b.email==='string'?b.email.trim().toLowerCase():'';const password=typeof b.password==='string'?b.password:'';
 if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8||password.length>128)return json({error:'กรุณากรอกอีเมลให้ถูกต้องและรหัสผ่านอย่างน้อย 8 ตัวอักษร'},400);
 let user:any;
 if(action==='register'){
  const name=typeof b.name==='string'?b.name.trim():'';const role=b.role;
  if(name.length<2||name.length>120||!['teacher','student'].includes(role))return json({error:'กรุณากรอกชื่อและเลือกบทบาทให้ถูกต้อง'},400);
  const id=crypto.randomUUID(),salt=toHex(crypto.getRandomValues(new Uint8Array(16))),hash=await passwordHash(password,salt);
  try{await db.prepare('INSERT INTO auth_users(id,name,email,role,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,name,email,role,salt,hash,Date.now()).run()}catch{return json({error:'อีเมลนี้มีบัญชีแล้ว'},409)}
  user={userId:id,displayName:name,email,fullName:name,role};
 }else if(action==='login'){
  const row:any=await db.prepare('SELECT id,name,email,role,password_salt,password_hash FROM auth_users WHERE email=?').bind(email).first();
  if(!row||await passwordHash(password,row.password_salt)!==row.password_hash)return json({error:'อีเมลหรือรหัสผ่านไม่ถูกต้อง'},401);
  user={userId:row.id,displayName:row.name,email:row.email,fullName:row.name,role:row.role};
 }else return json({error:'ไม่พบรายการ'},404);
 const token=toHex(crypto.getRandomValues(new Uint8Array(32))),expires=Date.now()+30*24*60*60*1000;
 await db.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),user.userId,await digest(token),expires,Date.now()).run();
 return new Response(JSON.stringify({user:{name:user.displayName,email:user.email,role:user.role}}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':`examflow_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${new URL(r.url).protocol==='https:'?'; Secure':''}`}});
}
async function logoutRequest(r:Request,db:any,redirectToHome=false){const token=cookieToken(r);if(token)await db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await digest(token)).run();const headers={'Set-Cookie':'examflow_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0','Cache-Control':'no-store'};return redirectToHome?new Response(null,{status:302,headers:{...headers,Location:'/'}}):new Response(JSON.stringify({ok:true}),{headers:{...headers,'Content-Type':'application/json'}})}
async function handle(r:Request){try{
 const db=env.DB!; const p=new URL(r.url).pathname.split('/').filter(Boolean).slice(1); const now=Date.now();
 if(p[0]==='auth'&&p[1]==='logout'&&r.method==='POST')return await logoutRequest(r,db);
 if(p[0]==='auth'&&p[1]==='logout'&&r.method==='GET')return await logoutRequest(r,db,true);
 if(p[0]==='auth'&&r.method==='POST')return await authRequest(r,p[1],db);
 const u=await getAccountUser(r,db); if(!u)return json({error:'กรุณาเข้าสู่ระบบก่อนใช้งาน'},401);
 const roleMethods:Record<string,Record<string,string[]>>={teacher:{me:['GET'],exams:['GET','POST'],results:['GET'],video:['GET'],camera:['GET']},student:{me:['GET'],join:['POST'],start:['POST'],attempt:['POST']}};
 const allowedMethods=roleMethods[u.role]?.[p[0]];
 if(!allowedMethods)return json({error:'บัญชีนี้ไม่มีสิทธิ์ใช้งานรายการดังกล่าว'},403);
 if(!allowedMethods.includes(r.method))return json({error:'ไม่รองรับ method นี้'},405);
 if(p[0]==='me')return json({name:u.displayName,role:u.role});
 if(p[0]==='exams'&&r.method==='GET'){
 const rows=await db.prepare('SELECT * FROM exams WHERE owner=? ORDER BY created DESC').bind(u.userId).all();return json(rows.results.map((x:any)=>({...x,...JSON.parse(x.body),body:undefined})));}
 if(p[0]==='exams'&&r.method==='POST'){
 const b:any=await r.json();if(!b.title?.trim()||b.title.length>200||!Number.isInteger(b.minutes)||b.minutes<1||b.minutes>180||!Array.isArray(b.questions)||b.questions.length<1||b.questions.length>100||b.questions.some((q:any)=>!q.text?.trim()||q.text.length>3000||!Array.isArray(q.options)||q.options.length!==4||q.options.some((v:any)=>typeof v!=='string'||!v.trim()||v.length>1000)||!Number.isInteger(q.correct)||q.correct<0||q.correct>3))return json({error:'ตรวจสอบชื่อข้อสอบ เวลา และตัวเลือกให้ครบ'},400);
 const id=crypto.randomUUID(),code=crypto.randomUUID().replaceAll('-','').slice(0,10).toUpperCase();await db.prepare('INSERT INTO exams(id,owner,code,body,created) VALUES(?,?,?,?,?)').bind(id,u.userId,code,JSON.stringify({title:b.title,subject:b.subject||'ทั่วไป',minutes:b.minutes,questions:b.questions}),now).run();return json({id,code});}
 if(p[0]==='join'){
 const b:any=await r.json();const e:any=await db.prepare('SELECT * FROM exams WHERE code=?').bind(String(b.code).trim().toUpperCase()).first();if(!e)return json({error:'ไม่พบรหัสข้อสอบนี้'},404);const body=JSON.parse(e.body);return json({id:e.id,title:body.title,minutes:body.minutes,count:body.questions.length});}
 if(p[0]==='start'){
 const b:any=await r.json();if(b.cameraConsent!==true)return json({error:'ต้องยินยอมให้ใช้กล้องและบันทึกวิดีโอก่อนเริ่มสอบ'},400);if(!b.name?.trim()||b.name.length>120)return json({error:'กรอกชื่อผู้สอบ'},400);const e:any=await db.prepare('SELECT * FROM exams WHERE id=?').bind(b.exam).first();if(!e)return json({error:'ไม่พบข้อสอบ'},404);
 let a:any=await db.prepare('SELECT * FROM attempts WHERE exam=? AND student=? ORDER BY started DESC LIMIT 1').bind(e.id,u.userId).first();if(a?.submitted)return json({error:'คุณส่งข้อสอบนี้แล้ว'},409);if(!a){const id=crypto.randomUUID();await db.prepare('INSERT INTO attempts(id,exam,student,name,started,camera_consent_at) VALUES(?,?,?,?,?,?)').bind(id,e.id,u.userId,b.name.trim(),now,now).run();a={id,started:now,answers:'{}',camera_consent_at:now};}else if(!a.camera_consent_at){await db.prepare('UPDATE attempts SET camera_consent_at=? WHERE id=?').bind(now,a.id).run();a.camera_consent_at=now;}const body=JSON.parse(e.body);return json({id:a.id,deadline:a.started+body.minutes*60000,answers:JSON.parse(a.answers),questions:body.questions.map(({correct,...q}:any)=>q)});}
 if(p[0]==='results'){
 const e:any=await db.prepare('SELECT * FROM exams WHERE id=? AND owner=?').bind(p[1],u.userId).first();if(!e)return json({error:'ไม่มีสิทธิ์'},403);const rows=await db.prepare('SELECT * FROM attempts WHERE exam=? ORDER BY started DESC').bind(e.id).all();return json(rows.results.map((a:any)=>({...a,events:JSON.parse(a.events),recordings:JSON.parse(a.recordings),cameraRecordings:JSON.parse(a.camera_recordings||'[]'),proctoringEvents:JSON.parse(a.proctoring||'[]'),camera_consent_at:undefined,camera_recordings:undefined,proctoring:undefined,answers:undefined,student:undefined})));}
 if(p[0]==='video'){
 const a:any=await db.prepare('SELECT a.* FROM attempts a JOIN exams e ON e.id=a.exam WHERE a.id=? AND e.owner=?').bind(p[1],u.userId).first();if(!a)return json({error:'ไม่มีสิทธิ์'},403);const key=JSON.parse(a.recordings)[Number(p[2])];if(!key)return json({error:'ไม่พบวิดีโอ'},404);const obj=await env.BUCKET!.get(key);if(!obj)return json({error:'ไม่พบวิดีโอ'},404);return new Response(obj.body,{headers:{'Content-Type':obj.httpMetadata?.contentType||'video/webm','Cache-Control':'private, no-store'}});}
 if(p[0]==='camera'){
 const a:any=await db.prepare('SELECT a.* FROM attempts a JOIN exams e ON e.id=a.exam WHERE a.id=? AND e.owner=?').bind(p[1],u.userId).first();if(!a)return json({error:'ไม่มีสิทธิ์'},403);const key=JSON.parse(a.camera_recordings||'[]')[Number(p[2])];if(!key)return json({error:'ไม่พบวิดีโอเว็บแคม'},404);const obj=await env.BUCKET!.get(key);if(!obj)return json({error:'วิดีโอหมดอายุหรือไม่พบไฟล์'},404);return new Response(obj.body,{headers:{'Content-Type':obj.httpMetadata?.contentType||'video/webm','Cache-Control':'private, no-store'}});}
 if(p[0]==='attempt'){
 const a:any=await db.prepare('SELECT * FROM attempts WHERE id=? AND student=?').bind(p[1],u.userId).first();if(!a)return json({error:'ไม่มีสิทธิ์'},403);if(a.submitted)return json({error:'ส่งข้อสอบแล้ว'},409);
 const e:any=await db.prepare('SELECT * FROM exams WHERE id=?').bind(a.exam).first();const exam=JSON.parse(e.body);const deadline=a.started+exam.minutes*60000;
 if(p[2]==='camera'){
 if(!a.camera_consent_at)return json({error:'ไม่มีหลักฐานความยินยอมให้ใช้กล้อง'},403);
 const type=r.headers.get('content-type')||'';if(!/^video\/(webm|mp4)/.test(type))return json({error:'ชนิดไฟล์เว็บแคมไม่รองรับ'},400);if(Number(r.headers.get('content-length')||0)>20*1024*1024)return json({error:'ไฟล์เว็บแคมใหญ่เกินไป'},413);
 const data=await r.arrayBuffer();if(!data.byteLength||data.byteLength>20*1024*1024)return json({error:'ขนาดไฟล์เว็บแคมไม่ถูกต้อง'},400);
 const previous=JSON.parse(a.camera_recordings||'[]');if(previous.length>=Math.ceil(exam.minutes*60/15)+5)return json({error:'จำนวนช่วงวิดีโอเว็บแคมเกินที่กำหนด'},413);const key=`camera/${a.id}/${crypto.randomUUID()}`;
 await env.BUCKET!.put(key,data,{httpMetadata:{contentType:type}});
 await db.prepare("UPDATE attempts SET camera_recordings=json_insert(camera_recordings,'$[#]',?) WHERE id=?").bind(key,a.id).run();
 const analysis=await analyzeCamera(data,type);
 const record={segment:previous.length,at:now,...analysis};
 await db.prepare("UPDATE attempts SET proctoring=json_insert(proctoring,'$[#]',json(?)) WHERE id=?").bind(JSON.stringify(record),a.id).run();
 return json({ok:true,analysis:{status:analysis.status,reviewFlags:analysis.reviewFlags}});
 }
 if(p[2]==='record'){
 const size=Number(r.headers.get('content-length')||0);if(size>20*1024*1024)return json({error:'ไฟล์ใหญ่เกินไป'},413);const data=await r.arrayBuffer();if(!data.byteLength||data.byteLength>20*1024*1024)return json({error:'ขนาดไฟล์ไม่ถูกต้อง'},400);const type=r.headers.get('content-type')||'';if(!/^video\/(webm|mp4)/.test(type))return json({error:'ชนิดไฟล์ไม่รองรับ'},400);const key=a.id+'/'+crypto.randomUUID();await env.BUCKET!.put(key,data,{httpMetadata:{contentType:type}});await db.prepare("UPDATE attempts SET recordings=json_insert(recordings,'$[#]',?) WHERE id=?").bind(key,a.id).run();return json({ok:true});}
 const b:any=await r.json();
 if(p[2]==='event'){const type=String(b.type).slice(0,120);await db.prepare("UPDATE attempts SET events=json_insert(events,'$[#]',json(?)) WHERE id=? AND json_array_length(events)<2000").bind(JSON.stringify({type,time:now}),a.id).run();return json({ok:true});}
 if(p[2]==='answers'){if(now>deadline)return json({error:'หมดเวลาสอบแล้ว'},409);const answers=b.answers||{};if(Object.entries(answers).some(([k,v])=>!/^\d+$/.test(k)||Number(k)>=exam.questions.length||!Number.isInteger(v)||Number(v)<0||Number(v)>3))return json({error:'คำตอบไม่ถูกต้อง'},400);await db.prepare('UPDATE attempts SET answers=? WHERE id=?').bind(JSON.stringify(answers),a.id).run();return json({ok:true});}
 if(p[2]==='submit'){if(!JSON.parse(a.recordings).length)return json({error:'กรุณารออัปโหลดบันทึกหน้าจอก่อนส่ง'},400);if(!JSON.parse(a.camera_recordings||'[]').length)return json({error:'กรุณารออัปโหลดวิดีโอเว็บแคมก่อนส่ง'},400);const answers=JSON.parse(a.answers);const score=exam.questions.reduce((s:number,q:any,i:number)=>s+(answers[i]===q.correct?1:0),0);await db.prepare('UPDATE attempts SET submitted=?,score=? WHERE id=?').bind(now,score,a.id).run();return json({score,total:exam.questions.length});}
 }
 return json({error:'ไม่พบรายการ'},404);
}catch(e){console.error(e);return json({error:'ระบบขัดข้อง กรุณาลองอีกครั้ง'},500)}}
