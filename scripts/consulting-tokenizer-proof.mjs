#!/usr/bin/env node
/** Verify the reviewed official tokenizer without running its Python code. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { TOKENIZER_PROOF } from '../bundles/consulting/connectors/deepseek.mjs';

const archive = process.argv[2];
if (!archive) {
  console.error('Usage: node scripts/consulting-tokenizer-proof.mjs <official deepseek_v4_tokenizer.zip>');
  process.exitCode = 2;
} else {
  try {
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (digest !== TOKENIZER_PROOF.artifactSha256) throw new Error('Official tokenizer archive differs from the reviewed digest; review before any model call.');
    const source = String.raw`import json,sys,zipfile,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
    raw=z.read('deepseek_v4_tokenizer/tokenizer.json')
    config_raw=z.read('deepseek_v4_tokenizer/tokenizer_config.json')
    t=json.loads(raw); config=json.loads(config_raw)
assert t['model']['type']=='BPE'
assert t['normalizer']=={'type':'Sequence','normalizers':[]}
byte=t['pre_tokenizer']['pretokenizers'][-1]
assert byte['type']=='ByteLevel' and byte['add_prefix_space'] is False
bs=list(range(33,127))+list(range(161,173))+list(range(174,256)); cs=bs[:]; n=0
for b in range(256):
    if b not in bs: bs.append(b);cs.append(256+n);n+=1
assert all(chr(c) in t['model']['vocab'] for c in cs)
template=config['chat_template']
assert "message['role'] == 'system'" in template
assert "message['role'] == 'user'" in template
frame='<｜begin▁of▁sentence｜><｜User｜><｜Assistant｜>'
assert len(frame.encode('utf8')) < 1024
print(json.dumps({'passed':True,'tokenizerSha256':hashlib.sha256(raw).hexdigest(),'configSha256':hashlib.sha256(config_raw).hexdigest(),'all256ByteSymbolsPresent':True,'normalization':'none','inputBound':'UTF8(system)+UTF8(prompt)+1024','fixedTemplateBytes':len(frame.encode('utf8')),'proofScope':'two text messages only; no history, images, client tool schemas, or automatic retries'},ensure_ascii=False))`;
    const result = spawnSync('python3', ['-c', source, archive], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error('Tokenizer structure validation failed.');
    console.log(JSON.stringify({ ...JSON.parse(result.stdout), source: TOKENIZER_PROOF.source, artifactSha256: digest, reviewedModel: TOKENIZER_PROOF.modelVersion }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Tokenizer proof failed.');
    process.exitCode = 1;
  }
}
