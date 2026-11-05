import {build} from 'esbuild';
import {mkdir,copyFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
await mkdir('dist',{recursive:true});
await build({entryPoints:['client.tsx'],bundle:true,minify:true,outfile:'dist/app.js',jsx:'automatic',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[resolve('node_modules')]});
await copyFile('../app/globals.css','dist/styles.css');
await build({entryPoints:['server.mjs'],bundle:true,outfile:'dist/server.mjs',platform:'node',format:'esm',target:'node24',plugins:[{name:'portable-adapter',setup(b){b.onLoad({filter:/route\.ts$/},async args=>{let s=await readFile(args.path,'utf8');s=s.replace("import { env } from 'cloudflare:workers';",`import {env,getUser} from '${resolve('node-env.mjs').replaceAll('\\','/')}';`).replace("import { getChatGPTUser } from '../../chatgpt-auth';",'').replace('await getChatGPTUser()','await getUser(r)');return {contents:s,loader:'ts',resolveDir:resolve('../app/api/[...path]')};});}}]});
console.log('Portable build ready');
