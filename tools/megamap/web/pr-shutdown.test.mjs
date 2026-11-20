import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMegamapHandler} from './server.mjs';

test('closing cancels the first comparison index after Git preparation has finished',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'spamton-pr-shutdown-'));
  const previous=process.env.PATH;let handler,server;
  try {
    const root=join(directory,'repo'),bin=join(directory,'spamton-bin');await mkdir(root);await mkdir(bin);
    const env={...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'};
    const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-C',root,...args],{env,encoding:'utf8'}).trim();
    git('init','-q');await writeFile(join(root,'app.rb'),'class App; end\n');git('add','.');git('commit','-qm','Snapshot');const sha=git('rev-parse','HEAD');
    await writeFile(join(bin,'gh'),[`#!${process.execPath}`,`const route=process.argv[3];console.log(route.includes('/compare/')?${JSON.stringify(sha)}:JSON.stringify(${JSON.stringify({number:42,title:'Fixture',repository:'fixture/project',baseSha:sha,headSha:sha})}));`,''].join('\n'),{mode:0o755});
    const binary=join(bin,'spamton-slow-analysis.mjs'),started=join(directory,'spamton-analysis-started');
    await writeFile(binary,[`#!${process.execPath}`,"import {createInterface} from 'node:readline';", "import {writeFileSync} from 'node:fs';",`createInterface({input:process.stdin}).on('line',async line=>{const r=JSON.parse(line);writeFileSync(${JSON.stringify(started)},'started');await new Promise(done=>setTimeout(done,2500));process.stdout.write(JSON.stringify({id:r.id,result:{nodes:[],pr:{number:42}}})+String.fromCharCode(10));});`,''].join('\n'),{mode:0o755});
    process.env.PATH=bin+':'+previous;
    handler=await createMegamapHandler({binary,projects:[{id:'fixture',root,repository:'fixture/project'}]});
    server=http.createServer((req,res)=>handler.handle(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const url=`http://127.0.0.1:${server.address().port}/megamap/api/`,config=await(await fetch(url+'config')).json();
    const request=fetch(url+'pr?project=fixture',{method:'POST',headers:{'content-type':'application/json','x-megamap-token':config.token},body:JSON.stringify({number:42})});
    let indexing=false;for(let i=0;i<250;i++){try{await access(started);indexing=true;break;}catch{}await new Promise(done=>setTimeout(done,20));}
    assert.equal(indexing,true,'analysis must have started after the preparation helper finished');
    const began=Date.now();await handler.close();const elapsed=Date.now()-began;
    const response=await request;await response.json();
    assert(elapsed<1200,`close waited ${elapsed}ms for indexing instead of cancelling`);
    assert.equal(response.status,503);
  }finally{
    if(handler)await handler.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}
    process.env.PATH=previous;await rm(directory,{recursive:true,force:true});
  }
});
