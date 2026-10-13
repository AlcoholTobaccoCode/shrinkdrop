import { fileURLToPath } from 'node:url';

//#region Server测试账号隔离
// 强制覆盖外部账号路径，普通测试不能读取开发者真实账号或触发官方validate。
process.env.TINIFY_ACCOUNTS = fileURLToPath(new URL('./fixtures/empty-accounts.json', import.meta.url));
//#endregion
