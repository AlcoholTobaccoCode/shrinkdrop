import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { appFixture, createBatch, addImage, headers, waitCompleted } from './fixtures';
describe('B11 结果与输出重试',()=>{
 it('结果下载和zip保留原名，重复文件名添加序号',async()=>{
  const {app}=appFixture();const {id}=await createBatch(app);
  expect((await app.inject({url:`/api/v1/batches/${id}/archive`,headers})).statusCode).toBe(409);
  await addImage(app,id);await addImage(app,id);await addImage(app,id,'青山.png');await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});const done=await waitCompleted(app,id);
  const file=await app.inject({url:`/api/v1/jobs/${done.jobs[0].jobId}/result`,headers});expect(file.statusCode).toBe(200);expect(file.headers['content-type']).toContain('image/png');
  const zip=await app.inject({url:`/api/v1/batches/${id}/archive`,headers});expect(zip.statusCode).toBe(200);expect(Object.keys(unzipSync(zip.rawPayload))).toEqual(['photo.png','photo (2).png','青山.png']);
  expect((await app.inject({url:`/api/v1/jobs/${done.jobs[0].jobId}/result`,headers:{authorization:'Bearer b'}})).statusCode).toBe(404);await app.close();
 });
 it('输出失败保持Provider结果，outputs重试不再次调用Provider',async()=>{
  let fail=true;const {app,providers}=appFixture({outputWriter:async()=>{if(fail)throw new Error('disk unavailable');}});
  const {id}=await createBatch(app);await addImage(app,id);await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});const done=await waitCompleted(app,id);const j=done.jobs[0];expect(j.status).toBe('completed');expect(j.result).toBeDefined();expect(j.outputs[0].status).toBe('failed');
  fail=false;const retry=await app.inject({method:'POST',url:`/api/v1/jobs/${j.jobId}/retry`,headers,payload:{scope:'outputs'}});expect(retry.statusCode).toBe(200);const after=await waitCompleted(app,id);expect(after.jobs[0].outputs[0].status).toBe('completed');expect(providers.execute).toHaveBeenCalledTimes(1);await app.close();
 });
});

import { fixtureService } from './fixtures';
import { vi } from 'vitest';
it('取消输出重试后完整重试，旧writer不能覆盖新processing结果',async()=>{
 let executions=0,writes=0;let releaseProvider!:()=>void;let releaseWriter!:()=>void;
 const providers=fixtureService(vi.fn(async(input)=>{executions++;if(executions===2)await new Promise<void>(r=>releaseProvider=r);return {data:input.data,mimeType:input.mimeType,width:2,height:2};}));
 const {app}=appFixture({providers,outputWriter:async()=>{writes++;if(writes===1)throw new Error('save failed');if(writes===2)await new Promise<void>(r=>releaseWriter=r);}});
 try {
  const {id}=await createBatch(app);await addImage(app,id);await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});const initial=await waitCompleted(app,id);const jobId=initial.jobs[0].jobId;
  const outputs=app.inject({method:'POST',url:`/api/v1/jobs/${jobId}/retry`,headers,payload:{scope:'outputs'}});await vi.waitFor(()=>expect(writes).toBe(2));
  await app.inject({method:'POST',url:`/api/v1/jobs/${jobId}/cancel`,headers});await app.inject({method:'POST',url:`/api/v1/jobs/${jobId}/retry`,headers,payload:{scope:'all'}});await vi.waitFor(()=>expect(executions).toBe(2));
  releaseWriter();await outputs;const before=(await app.inject({url:`/api/v1/jobs/${jobId}`,headers})).json();expect(before.status).toBe('processing');expect(before.result).toBeUndefined();
  releaseProvider();const after=await waitCompleted(app,id);expect(after.jobs[0].status).toBe('completed');expect(executions).toBe(2);
 }finally{releaseProvider?.();releaseWriter?.();await app.close();}
});

import { resultName } from '../src/results';
it('下载保留上传文件名字面的百分号编码，只解码URL路径',()=>{
 const base={jobId:'name',batchId:'batch',ownerTokenId:'alice',seq:0,providerId:'official-tinify',status:'completed' as const,attempts:1,outputs:[],input:{mime:'image/png',size:100,width:2,height:2},result:{mime:'image/png',size:80,width:2,height:2,savedRatio:0.2},createdAt:'2026-10-13T00:00:00.000Z',updatedAt:'2026-10-13T00:00:00.000Z'};
 expect(resultName({...base,source:{kind:'upload',filename:'photo%20final.png',size:100}})).toBe('photo%20final.png');
 expect(resultName({...base,source:{kind:'upload',filename:'folder%2Fphoto.png',size:100}})).toBe('folder%2Fphoto.png');
 expect(resultName({...base,source:{kind:'url',host:'public.example',url:'https://public.example/photo%20final.png'}})).toBe('photo final.png');
});

import { createArchive } from '../src/results';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
it('ZIP在背压下按文件读取，取消下载不会继续打开其余结果',async()=>{
 const noise=await sharp(randomBytes(512*512*3),{raw:{width:512,height:512,channels:3}}).png().toBuffer();
 const providers=fixtureService(vi.fn(async()=>({data:noise,mimeType:'image/png',width:512,height:512})));
 const {app}=appFixture({providers});
 try {
  const {id}=await createBatch(app);await addImage(app,id);await addImage(app,id);await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});await waitCompleted(app,id);
  const paths=vi.spyOn(app.runtime.store,'filePath');const stream=await createArchive(app.runtime.store,app.runtime.store.listJobs(id));
  expect(typeof stream.destroy).toBe('function');
  const iterator=stream[Symbol.asyncIterator]();const first=await iterator.next();expect(first.value.byteLength).toBeGreaterThan(0);
  stream.destroy();await iterator.return?.().catch(()=>undefined);await vi.waitFor(()=>expect(stream.closed).toBe(true));expect(paths).toHaveBeenCalledTimes(3);paths.mockRestore();
 }finally{await app.close();}
});

import { truncateSync } from 'node:fs';
import { get } from 'node:http';
it('app.close终止客户端暂停读取的ZIP响应，释放背压等待',async()=>{
 const {app}=appFixture();const {id}=await createBatch(app);await addImage(app,id);await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});const batch=await waitCompleted(app,id);const job=app.runtime.store.getJob(batch.jobs[0].jobId)!;
 truncateSync(app.runtime.store.filePath(job.resultFile!),20*1024*1024);await app.listen({port:0,host:'127.0.0.1'});const address=app.server.address();if(!address||typeof address==='string')throw new Error('missing fixture listener');
 const response=await new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{const request=get(`http://127.0.0.1:${address.port}/api/v1/batches/${id}/archive`,{headers},response=>{response.pause();resolve(response);});request.on('error',reject);});
 const closed=app.close();let timer:ReturnType<typeof setTimeout>;
 try {await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('ZIP backpressure blocked app.close')),200);})]);}
 finally{clearTimeout(timer!);response.destroy();await closed;}
});
