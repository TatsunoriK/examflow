import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {GET,POST} from '../app/api/[...path]/route';
const port=Number(process.env.PORT||4173);
const shell='<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ExamFlow • Local Preview</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
createServer(async(req,res)=>{try{
 const url=new URL(req.url||'/',`http://127.0.0.1:${port}`);
 if(url.pathname==='/health'){res.writeHead(200);return res.end('ok');}
 if(url.pathname.startsWith('/api/')){
 let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>21*1024*1024){res.writeHead(413);res.end('Too large');return;}chunks.push(b);}
 const body=Buffer.concat(chunks);const r=new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )});const response=await (req.method==='GET'?GET:POST)(r);
 res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(Buffer.from(await response.arrayBuffer()));
 }
 const assets={'/app.js':['app.js','text/javascript'],'/styles.css':['styles.css','text/css']};
 if(assets[url.pathname]){const [file,type]=assets[url.pathname];res.writeHead(200,{'Content-Type':type});return res.end(readFileSync(new URL('./'+file,import.meta.url)));}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(shell);
 }catch(e){console.error(e);res.writeHead(500);res.end('Local preview error');}
}).listen(port,'127.0.0.1',()=>console.log(`ExamFlow local preview: http://127.0.0.1:${port}`));
