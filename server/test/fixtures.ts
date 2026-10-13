import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { vi } from 'vitest';
import type { ImageProviderManifest, ProviderUsageResponse } from '@tinypng/shared';
import { buildApp } from '../src/app';
import { parseConfig } from '../src/config';
import { sha256Hex } from '../src/auth';

export const manifests: ImageProviderManifest[] = ['official-tinify', 'anonymous-tinify'].map(id => ({
  id, label: id, processing: 'cloud', capabilities: { compress: true, convert: id === 'official-tinify' ? ['png','jpeg','webp','avif'] : [], resize: id === 'official-tinify', smartResize: false, crop: false, smartCrop: false, metadata: [], urlInput: true, storageOutput: false },
}));
export const config = parseConfig({ auth: { tokens: [{ id: 'alice', sha256: sha256Hex('a') }, { id: 'bob', sha256: sha256Hex('b') }] } });
export const headers = { authorization: 'Bearer a' };
export const batchBody = { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] };
export const png = () => sharp({create:{width:2,height:2,channels:3,background:'#ff0000'}}).png().toBuffer();
export function fixtureService(execute = vi.fn(async (input: {data:Uint8Array;mimeType:string}) => ({ data: input.data, mimeType: input.mimeType, width:2, height:2 }))) {
  return { list: () => manifests, execute, usage: (id:string):ProviderUsageResponse => ({providerId:id,accounts:[]}), refreshUsage: async (id:string):Promise<ProviderUsageResponse> => ({providerId:id,accounts:[]}), close: vi.fn() };
}
export function appFixture(options: Record<string, unknown> = {}) {
  const providers = fixtureService();
  const app = buildApp(config, { providers, dataDir: mkdtempSync(join(tmpdir(),'jobs-api-')), ...options });
  return { app, providers };
}
export async function createBatch(app: ReturnType<typeof buildApp>, extra = {}, token = headers) {
  const r = await app.inject({method:'POST',url:'/api/v1/batches',headers:token,payload:{...batchBody,...extra}});
  return {response:r,id:r.json().batchId as string};
}
export function multipart(files: {name:string;data:Uint8Array;type?:string}[]) {
  const boundary='test-image-boundary';
  const payload=Buffer.concat(files.flatMap(f=>[Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type??'image/png'}\r\n\r\n`),Buffer.from(f.data),Buffer.from('\r\n')]).concat(Buffer.from(`--${boundary}--\r\n`)));
  return {payload,headers:{...headers,'content-type':`multipart/form-data; boundary=${boundary}`}};
}
export async function addImage(app: ReturnType<typeof buildApp>,id:string,name='photo.png') {
  return app.inject({method:'POST',url:`/api/v1/batches/${id}/items`,...multipart([{name,data:await png()}])});
}
export const waitCompleted = async (app: ReturnType<typeof buildApp>,id:string) => {
  await vi.waitFor(async()=>{
    const r=await app.inject({url:`/api/v1/batches/${id}`,headers});
    if(r.json().jobs.some((j:{status:string})=>['queued','processing','uploading','saving'].includes(j.status))) throw new Error('still running');
  });
  return (await app.inject({url:`/api/v1/batches/${id}`,headers})).json();
};
