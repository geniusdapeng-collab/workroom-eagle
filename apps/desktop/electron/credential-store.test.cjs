const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readModelKey, writeModelKey, writeAgentToken } = require('./credential-store.cjs');
const key = 'sk-' + 'testcredential'.repeat(3);
const storage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };

test('模型密钥只保存系统加密字节，拒绝不安全存储和非法格式', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-credential-test-'));
  try {
    writeModelKey(dir, key, storage);
    const file = path.join(dir, 'deepseek-key.enc');
    assert.equal(fs.readFileSync(file).includes(Buffer.from(key)), false);
    assert.equal(readModelKey(dir, storage), key);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writeModelKey(dir, key, { ...storage, isEncryptionAvailable: () => false }), /拒绝以明文/);
    assert.throws(() => writeModelKey(dir, key, { ...storage, getSelectedStorageBackend: () => 'basic_text' }), /拒绝以明文/);
    assert.throws(() => writeModelKey(dir, 'invalid', storage), /格式不合法/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Agent token只送到security标准输入，不进入argv，失败明确返回', () => {
  const token = 'header.payload.' + 'signature'.repeat(6);
  writeAgentToken(token, (cmd, args, options) => {
    assert.equal(cmd, '/usr/bin/security');
    assert.equal(args.join(' ').includes(token), false);
    if (args[0] === 'find-generic-password') return { status: 0, stdout: `${token}\n` };
    assert.equal(options.input.includes(token), true);
    return { status: 0, stderr: '' };
  });
  assert.throws(() => writeAgentToken(token, () => ({ status: 1, stderr: 'denied' })), /钥匙串写入失败/);
  assert.throws(() => writeAgentToken('bad\ncommand'), /格式不合法/);
});
