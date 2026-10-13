import { describe, it, expect } from 'vitest';
import { appFixture,createBatch,headers,multipart,png } from './fixtures';
describe('B10 URL/图片输入',()=>{
 it('拒绝私网IPv4/IPv6/CGNAT/组播/非法协议，导入不调用Provider',async()=>{
  const {app,providers}=appFixture();const {id}=await createBatch(app);
  for(const url of ['http://127.0.0.1/a.png','http://10.1.2.3/a','http://169.254.2.3/a','http://100.64.1.1/a','http://224.0.0.1/a','http://[::1]/a','http://[fc00::1]/a','http://[fe80::1]/a','http://[ff02::1]/a','http://[::ffff:127.0.0.1]/a','file:///a','http://user:pass@example.com/a']){
   const r=await app.inject({method:'POST',url:`/api/v1/batches/${id}/items`,headers,payload:{urls:[url]}});expect(r.statusCode,url).toBe(422);expect(r.json().code,url).toBe('URL_FORBIDDEN');
  }
  expect(providers.execute).not.toHaveBeenCalled();await app.close();
 });
 it('上传校验真实解码/MIME且限制20MB',async()=>{
  const {app}=appFixture();const {id}=await createBatch(app);
  const bad=await app.inject({method:'POST',url:`/api/v1/batches/${id}/items`,...multipart([{name:'fake.png',data:Buffer.from('not png')}])});expect(bad.statusCode).toBe(415);
  const spoof=await app.inject({method:'POST',url:`/api/v1/batches/${id}/items`,...multipart([{name:'a.jpg',data:await png(),type:'image/jpeg'}])});expect(spoof.statusCode).toBe(415);
  const large=await app.inject({method:'POST',url:`/api/v1/batches/${id}/items`,...multipart([{name:'large.png',data:Buffer.alloc(20*1024*1024+1)}])});expect(large.statusCode).toBe(413);expect(large.json().code).toBe('FILE_TOO_LARGE');await app.close();
 });
});

import { fetchUrlImage, isForbiddenAddress, type UrlTransport } from '../src/url-input';
import { vi } from 'vitest';
describe('B10 DNS/重定向契约',()=>{
 it('每跳只解析一次并将锁定IP传给transport，混合私网DNS拒绝',async()=>{
  const resolve=vi.fn(async()=>[{address:'93.184.216.34',family:4}]);const image=await png();
  const transport:UrlTransport=vi.fn(async(_url,address)=>{expect(address).toEqual({address:'93.184.216.34',family:4});return {status:200,headers:{'content-type':'image/png'},data:image};});
  const result=await fetchUrlImage('https://public.example/image',undefined,{resolve,transport});expect(result.info.mime).toBe('image/png');expect(resolve).toHaveBeenCalledTimes(1);
  await expect(fetchUrlImage('https://mixed.example/image',undefined,{resolve:async()=>[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}],transport})).rejects.toMatchObject({code:'URL_FORBIDDEN'});
  expect(transport).toHaveBeenCalledTimes(1);
 });
 it('重定向到内网在请求前被拦，超过3次重定向拒绝',async()=>{
  const resolve=async()=>[{address:'93.184.216.34',family:4}];const transport=vi.fn(async()=>({status:302,headers:{location:'http://127.0.0.1/a'},data:new Uint8Array()}));
  await expect(fetchUrlImage('https://public.example/a',undefined,{resolve,transport})).rejects.toMatchObject({code:'URL_FORBIDDEN'});expect(transport).toHaveBeenCalledTimes(1);
  const loop=vi.fn(async()=>({status:302,headers:{location:'/next'},data:new Uint8Array()}));await expect(fetchUrlImage('https://public.example/a',undefined,{resolve,transport:loop})).rejects.toMatchObject({code:'URL_FORBIDDEN'});expect(loop).toHaveBeenCalledTimes(4);
 });
 it('URL20MB限制、真实MIME和IPv6映射地址不能绕过',async()=>{
  const resolve=async()=>[{address:'93.184.216.34',family:4}];
  await expect(fetchUrlImage('https://public.example/a',undefined,{resolve,transport:async()=>({status:200,headers:{'content-type':'image/png'},data:Buffer.alloc(20*1024*1024+1)})})).rejects.toMatchObject({code:'FILE_TOO_LARGE'});
  await expect(fetchUrlImage('https://public.example/a',undefined,{resolve,transport:async()=>({status:200,headers:{'content-type':'text/html'},data:Buffer.from('html')})})).rejects.toMatchObject({code:'UNSUPPORTED_MIME'});
  for(const ip of ['::ffff:a00:1','::ffff:6440:101','::','2002:a00:1::','192.168.1.1'])expect(isForbiddenAddress(ip),ip).toBe(true);
  expect(isForbiddenAddress('2001:4860:4860::8888')).toBe(false);
 });
 it('DNS悬挂也必须在URL期限内退出',async()=>{
  await expect(fetchUrlImage('https://public.example/a',undefined,{resolve:()=>new Promise(()=>{}),timeoutMs:10})).rejects.toMatchObject({code:'URL_FETCH_FAILED'});
 },100);
});

import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { pinnedRequest } from '../src/url-input';
it('锁IP真实传输不查第二次DNS，重定向立即关闭未结束响应体',async()=>{
 const sockets=new Set<Socket>();let host:string|undefined;
 const fixture=createServer((request,response)=>{host=request.headers.host;response.writeHead(302,{location:'http://other.invalid/image.png'});response.write('redirect body keeps open');});
 fixture.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const address=fixture.address();if(!address||typeof address==='string')throw new Error('missing fixture listener');
 try {
  const result=await pinnedRequest(new URL(`http://public.invalid:${address.port}/a.png`),{address:'127.0.0.1',family:4},new AbortController().signal,20*1024*1024);
  expect(result.status).toBe(302);expect(host).toBe(`public.invalid:${address.port}`);await vi.waitFor(()=>expect(sockets.size).toBe(0),{timeout:100});
 }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(r=>fixture.close(()=>r()));}
});

import sharp from 'sharp';
import { inspectImage } from '../src/validation';
it('AVIF实际解码识别heif/av1容器',async()=>{
 const data=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).avif().toBuffer();
 expect(await inspectImage(data,'image/avif')).toMatchObject({mime:'image/avif',width:2,height:2});
});

import { request as requestHttp } from 'node:http';
import { AppError } from '../src/errors';
it('上传请求体已结束后客户端断开，URL下载仍会被取消',async()=>{
 let signal:AbortSignal|undefined;let finish:()=>void=()=>{};
 const {app}=appFixture({urlFetcher:async(_url:string,incoming:AbortSignal)=>{signal=incoming;await new Promise<never>((_,reject)=>{finish=()=>reject(new AppError('URL_FETCH_FAILED','fixture canceled'));incoming.addEventListener('abort',finish,{once:true});});throw new Error('unreachable');}});
 const {id}=await createBatch(app);await app.listen({port:0,host:'127.0.0.1'});const address=app.server.address();if(!address||typeof address==='string')throw new Error('missing fixture listener');
 const request=requestHttp(`http://127.0.0.1:${address.port}/api/v1/batches/${id}/items`,{method:'POST',headers:{...headers,'Content-Type':'application/json'}});request.on('error',()=>{});request.end(JSON.stringify({urls:['https://public.example/a.png']}));
 try {await vi.waitFor(()=>expect(signal).toBeDefined());request.destroy();await vi.waitFor(()=>expect(signal?.aborted).toBe(true),{timeout:200});expect(app.runtime.store.listJobs(id)).toHaveLength(0);}
 finally{request.destroy();finish();await app.close();}
});

it('下载实现忽略abort并迟到返回时，不插入未绑定草稿',async()=>{
 const data=await png();let signal:AbortSignal|undefined;let release:()=>void=()=>{};
 const {app,providers}=appFixture({urlFetcher:async(url:string,incoming:AbortSignal)=>{signal=incoming;await new Promise<void>(resolve=>release=resolve);return {data,url,info:{mime:'image/png',size:data.length,width:2,height:2}};}});
 const {id}=await createBatch(app);await app.listen({port:0,host:'127.0.0.1'});const address=app.server.address();if(!address||typeof address==='string')throw new Error('missing fixture listener');
 const request=requestHttp(`http://127.0.0.1:${address.port}/api/v1/batches/${id}/items`,{method:'POST',headers:{...headers,'Content-Type':'application/json'}});request.on('error',()=>{});request.end(JSON.stringify({urls:['https://public.example/a.png']}));
 try{await vi.waitFor(()=>expect(signal).toBeDefined());request.destroy();await vi.waitFor(()=>expect(signal?.aborted).toBe(true));release();await new Promise<void>(resolve=>setImmediate(resolve));const state=await app.inject({url:`/api/v1/batches/${id}`,headers});expect(state.json().jobs).toHaveLength(0);expect(providers.execute).not.toHaveBeenCalled();}
 finally{request.destroy();release();await app.close();}
});
