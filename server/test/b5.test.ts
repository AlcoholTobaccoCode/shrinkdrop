import { describe, it, expect } from 'vitest';
import { appFixture, createBatch } from './fixtures';
describe('B5 manifest与第一阶段校验',()=>{
 it('匿名非compress返回422和官方建议，非法尺寸及输出被拒绝',async()=>{
  const {app,providers}=appFixture();
  const anon=await createBatch(app,{providerId:'anonymous-tinify',operations:[{type:'convert',format:'webp'}]});expect(anon.response.statusCode).toBe(422);expect(anon.response.json()).toMatchObject({code:'OPERATION_UNSUPPORTED',suggestProviderId:'official-tinify'});
  for(const extra of [{operations:[{type:'resize',width:0,fit:'inside'}]},{operations:[]},{destinations:[{type:'overwrite'}]},{operations:[{type:'crop',width:1,height:1}]}])expect((await createBatch(app,extra)).response.statusCode).toBe(422);
  expect(providers.execute).not.toHaveBeenCalled();await app.close();
 });
});
