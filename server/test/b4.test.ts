import { afterEach, describe, expect, it, vi } from 'vitest';
import { appFixture, createBatch, addImage, headers, fixtureService, waitCompleted } from './fixtures';
const apps:ReturnType<typeof appFixture>['app'][]=[];
afterEach(async()=>{for(const app of apps.splice(0)) await app.close();});
function setup(options={}) {const f=appFixture(options);apps.push(f.app);return f;}
describe('B4 批次 API',()=>{
 it('导入保持draft，只有手动开始才调用Provider，重复开始409',async()=>{
  const {app,providers}=setup();const {id,response}=await createBatch(app);expect(response.statusCode).toBe(201);
  const added=await addImage(app,id);expect(added.statusCode).toBe(201);expect(added.json().jobs[0].status).toBe('draft');expect(providers.execute).not.toHaveBeenCalled();
  expect((await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers})).statusCode).toBe(200);
  const done=await waitCompleted(app,id);expect(done.jobs[0].status).toBe('completed');expect(providers.execute).toHaveBeenCalledTimes(1);
  expect((await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers})).statusCode).toBe(409);
 });
 it('所有批次共享最多5个Provider并发',async()=>{
  let active=0,max=0;const releases:Array<()=>void>=[];
  const providers=fixtureService(vi.fn(async(input)=>{active++;max=Math.max(max,active);await new Promise<void>(r=>releases.push(r));active--;return {data:input.data,mimeType:input.mimeType,width:2,height:2};}));
  const {app}=setup({providers});const ids=[];
  for(let b=0;b<2;b++){const {id}=await createBatch(app);ids.push(id);for(let i=0;i<4;i++)await addImage(app,id);await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});}
  await vi.waitFor(()=>expect(active).toBe(5));expect(max).toBe(5);
  for(let i=0;i<8;i++){await vi.waitFor(()=>expect(releases[i]).toBeTypeOf('function'));releases[i]!();}
  for(const id of ids) await waitCompleted(app,id);expect(max).toBe(5);
 });
 it('处理中继续添加为draft，删除只接受draft',async()=>{
  let release!:()=>void;const providers=fixtureService(vi.fn(async(input)=>{await new Promise<void>(r=>release=r);return {data:input.data,mimeType:input.mimeType,width:2,height:2};}));
  const {app}=setup({providers});const {id}=await createBatch(app);const j=(await addImage(app,id)).json().jobs[0];await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});
  expect((await app.inject({method:'DELETE',url:`/api/v1/batches/${id}/items/${j.jobId}`,headers})).statusCode).toBe(409);
  const added=(await addImage(app,id)).json().jobs[0];expect(added.status).toBe('draft');
  expect((await app.inject({method:'DELETE',url:`/api/v1/batches/${id}/items/${added.jobId}`,headers})).statusCode).toBe(204);release();await waitCompleted(app,id);
 });
});

it('取消后立即完整重试，旧结果不覆盖新执行',async()=>{
 const releases:Array<()=>void>=[];const providers=fixtureService(vi.fn(async(input)=>{await new Promise<void>(r=>releases.push(r));return {data:input.data,mimeType:input.mimeType,width:2,height:2};}));
 const {app}=appFixture({providers});apps.push(app);const {id}=await createBatch(app);const job=(await addImage(app,id)).json().jobs[0];await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});await vi.waitFor(()=>expect(releases).toHaveLength(1));
 await app.inject({method:'POST',url:`/api/v1/jobs/${job.jobId}/cancel`,headers});const retry=await app.inject({method:'POST',url:`/api/v1/jobs/${job.jobId}/retry`,headers,payload:{scope:'all'}});expect(retry.statusCode).toBe(200);await vi.waitFor(()=>expect(releases).toHaveLength(2));releases[0]!();
 expect((await app.inject({url:`/api/v1/jobs/${job.jobId}`,headers})).json().status).toBe('processing');releases[1]!();const done=await waitCompleted(app,id);expect(done.jobs[0].status).toBe('completed');expect(done.jobs[0].attempts).toBe(2);
});

it('每token最多8个上传请求，超出429；另一token不共享上传限额',async()=>{
 const image=(await import('./fixtures')).png;const data=await image();let active=0;const releases:Array<()=>void>=[];
 const {app,providers}=appFixture({urlFetcher:async(url:string)=>{active++;await new Promise<void>(r=>releases.push(r));return {data,url,info:{mime:'image/png',size:data.length,width:2,height:2}};}});apps.push(app);
 const {id}=await createBatch(app);const requests=Array.from({length:8},()=>app.inject({method:'POST',url:`/api/v1/batches/${id}/items`,headers,payload:{urls:['https://public.example/a.png']}}));
 await vi.waitFor(()=>expect(active).toBe(8));const extra=await app.inject({method:'POST',url:`/api/v1/batches/${id}/items`,headers,payload:{urls:['https://public.example/a.png']}});expect(extra.statusCode).toBe(429);expect(extra.json().code).toBe('RATE_LIMITED');
 const otherHeaders={authorization:'Bearer b'};const other=await createBatch(app,{},otherHeaders);const otherRequest=app.inject({method:'POST',url:`/api/v1/batches/${other.id}/items`,headers:otherHeaders,payload:{urls:['https://public.example/a.png']}});await vi.waitFor(()=>expect(active).toBe(9));
 for(const release of releases)release();const responses=await Promise.all([...requests,otherRequest]);expect(responses.every(r=>r.statusCode===201)).toBe(true);expect(providers.execute).not.toHaveBeenCalled();
});

import { readdirSync } from 'node:fs';
import { png } from './fixtures';
import { AppError } from '../src/errors';
it('批量导入逐张暂存且提交前不可见，中途失败清理全部暂存文件',async()=>{
 const data=await png();let count=0;let id='';const {app}=appFixture({urlFetcher:async(url:string)=>{count++;if(count===2){expect(app.runtime.store.listJobs(id)).toHaveLength(0);expect(readdirSync(app.runtime.store.tmpDir)).toHaveLength(1);throw new AppError('URL_FETCH_FAILED','fixture failure');}return {url,data,info:{mime:'image/png',size:data.length,width:2,height:2}};}});apps.push(app);id=(await createBatch(app)).id;
 const response=await app.inject({method:'POST',url:`/api/v1/batches/${id}/items`,headers,payload:{urls:['https://public.example/1.png','https://public.example/2.png']}});expect(response.statusCode).toBe(502);expect(app.runtime.store.listJobs(id)).toHaveLength(0);expect(readdirSync(app.runtime.store.tmpDir)).toHaveLength(0);
});
