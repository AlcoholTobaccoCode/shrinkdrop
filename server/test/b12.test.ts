import { describe, it, expect,vi } from 'vitest';
import { appFixture, createBatch, addImage, headers, fixtureService, waitCompleted } from './fixtures';
describe('B12 SSE与取消',()=>{
 it('迟到结果不能覆盖canceled，全量GET与增量事件保持一致',async()=>{
  let release!:()=>void;const providers=fixtureService(vi.fn(async(input)=>{await new Promise<void>(r=>release=r);return {data:input.data,mimeType:input.mimeType,width:2,height:2};}));
  const {app}=appFixture({providers});const {id}=await createBatch(app);expect(id).toBeTypeOf('string');
  const events:unknown[]=[];const unsubscribe=app.runtime.events.subscribe(id,event=>events.push(event));
  const j=(await addImage(app,id)).json().jobs[0];await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  await app.inject({method:'POST',url:`/api/v1/jobs/${j.jobId}/cancel`,headers});release();const state=await waitCompleted(app,id);expect(state.jobs[0].status).toBe('canceled');expect(state.jobs[0].result).toBeUndefined();
  expect(events).toContainEqual(expect.objectContaining({type:'job',jobId:j.jobId,status:'canceled'}));expect(events).not.toContainEqual(expect.objectContaining({type:'job',jobId:j.jobId,status:'completed'}));unsubscribe();await app.close();
 });
 it('15秒heartbeat，订阅关闭释放计时器',async()=>{
  const {app}=appFixture();const {id}=await createBatch(app);expect(id).toBeTypeOf('string');vi.useFakeTimers();
  try {const events:unknown[]=[];const off=app.runtime.events.subscribe(id,event=>events.push(event));await vi.advanceTimersByTimeAsync(14999);expect(events).toHaveLength(0);await vi.advanceTimersByTimeAsync(1);expect(events[0]).toMatchObject({type:'heartbeat'});off();await vi.advanceTimersByTimeAsync(15000);expect(events).toHaveLength(1);} finally {vi.useRealTimers();await app.close();}
 });
});

it('真实SSE流保留CORS头、事件格式，关闭app会结束连接',async()=>{
 const {app}=appFixture();const {id}=await createBatch(app);await addImage(app,id);await app.inject({method:'POST',url:`/api/v1/batches/${id}/start`,headers});await waitCompleted(app,id);await app.listen({port:0,host:'127.0.0.1'});
 const address=app.server.address();if(!address||typeof address==='string')throw new Error('missing fixture listener');
 const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/batches/${id}/events`,{headers:{...headers,origin:'http://localhost:5170'}});
 expect(response.status).toBe(200);expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5170');
 const reader=response.body!.getReader();const first=await reader.read();const decoded=new TextDecoder().decode(first.value);expect(decoded).toContain('event: batch\n');expect(decoded).toContain(`"batchId":"${id}"`);expect(decoded).toContain('event: job\n');expect(decoded).toContain('"status":"completed"');expect(decoded).toContain('"result":');
 await app.close();await reader.cancel();
});
