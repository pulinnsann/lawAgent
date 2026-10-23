import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppStore } from '../src/core/storage';
import type { ModelConfigInput, ParsedContract, PublicModelConfig, ReviewContext, ReviewTask } from '../src/shared/contracts';

const apiConfig: ModelConfigInput = {
  name: '原有模型API', baseUrl: 'https://model.example.test/v1', model: 'original-api-model',
  responseFormat: 'json_schema', tokenParameter: 'max_completion_tokens', maxOutputTokens: 4096,
  contextWindowTokens: 64000, timeoutSeconds: 120,
};
const codexConfig: ModelConfigInput = {
  ...apiConfig, provider: 'codex-cli', name: '本机Codex登录会话', baseUrl: 'codex://local', model: 'default',
};
const context: ReviewContext = {
  contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced',
  businessContext: '仅验证配置持久化和审核来源关联的合成资料。',
};

function profile(store: AppStore, adapter: 'chat-completions' | 'codex-cli') {
  const row = store.rows('SELECT * FROM provider_profiles WHERE workspace_id=? AND adapter_id=?', [store.workspaceId, adapter])[0];
  assert.ok(row, `Missing provider profile: ${adapter}`);
  return row;
}

async function document(store: AppStore) {
  const body = '乙方完成服务后，甲方依据书面验收结果支付服务费用。';
  const parsed: ParsedContract = {
    format: 'docx', language: 'zh', warnings: [], partial: false, pageCount: null,
    blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: body,
      locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null } }],
  };
  return store.addDocument(randomUUID(), '合成配置关联样本.docx', 'documents/test-only/original.docx', 100,
    createHash('sha256').update(body).digest('hex'), parsed);
}

async function task(store: AppStore, documentId: string, config: PublicModelConfig, mode: 'model' | 'local' = 'model') {
  const value: ReviewTask = { id: randomUUID(), documentId, status: 'queued', stage: '合成配置关联检查',
    startedAt: new Date().toISOString(), finishedAt: null, error: null, resultId: null };
  return store.createTask(value, context, mode, null, config);
}

test('旧API配置省略provider仍可读取、重启并关联原profile，认证值不进入SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-codex-legacy-model-')); let store: AppStore | undefined;
  const secret = 'legacy-api-key-never-in-sqlite';
  try {
    store = await AppStore.open(dir);
    const saved = await store.saveConfig({ ...apiConfig, apiKey: secret, clearApiKey: true });
    assert.equal(saved.provider, undefined);
    assert.deepEqual(saved, { ...apiConfig, hasApiKey: false, keyStorage: 'session-only' });
    const original = profile(store, 'chat-completions');
    assert.equal(original.enabled, 1); assert.equal(original.credential_ref, 'default-model');
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getConfig(), saved);
    assert.equal(profile(store, 'chat-completions').id, original.id);
    const sample = await document(store);
    const runId = await task(store, sample.id, store.getConfig()!);
    assert.equal(store.rows('SELECT model_provider_profile_id FROM analysis_runs WHERE id=?', [runId])[0].model_provider_profile_id, original.id);
    await store.close(); store = undefined;
    assert.equal((await readFile(join(dir, 'workspace.sqlite'))).includes(Buffer.from(secret)), false);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('切到Codex保留原API设置与凭据引用，重启及切回后两类profile各自保持', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-codex-provider-switch-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir);
    await store.saveConfig(apiConfig);
    const firstApi = profile(store, 'chat-completions');
    store.rows('UPDATE provider_profiles SET credential_ref=? WHERE id=?', ['existing-api-credential-reference', firstApi.id]);
    const beforeApi = profile(store, 'chat-completions');
    const savedCodex = await store.saveConfig(codexConfig);
    assert.equal(savedCodex.provider, 'codex-cli'); assert.equal(savedCodex.baseUrl, 'codex://local');
    const codex = profile(store, 'codex-cli');
    assert.equal(codex.enabled, 1); assert.equal(codex.credential_ref, null);
    const { enabled: _oldEnabled, ...oldApiFields } = beforeApi;
    const { enabled: switchedEnabled, ...switchedApiFields } = profile(store, 'chat-completions');
    assert.equal(switchedEnabled, 0); assert.deepEqual(switchedApiFields, oldApiFields);
    assert.equal(store.rows("SELECT enabled FROM provider_profiles WHERE adapter_id='local-rules'")[0].enabled, 1);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getConfig(), savedCodex);
    assert.equal(profile(store, 'chat-completions').credential_ref, beforeApi.credential_ref);
    const restoredApi = await store.saveConfig(apiConfig);
    assert.deepEqual(restoredApi, { ...apiConfig, hasApiKey: false, keyStorage: 'session-only' });
    assert.equal(profile(store, 'chat-completions').id, firstApi.id);
    assert.equal(profile(store, 'chat-completions').credential_ref, beforeApi.credential_ref);
    const codexAfter = profile(store, 'codex-cli');
    assert.equal(codexAfter.enabled, 0); assert.equal(codexAfter.id, codex.id);
    assert.equal(codexAfter.settings_json, codex.settings_json); assert.equal(codexAfter.credential_ref, null);
    assert.equal(store.rows("SELECT COUNT(*) AS n FROM provider_profiles WHERE adapter_id IN ('chat-completions','codex-cli') AND enabled=1")[0].n, 1);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getConfig(), restoredApi);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('审核按捕获配置关联对应provider，连接切换不重绑历史或正在创建的审核', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-codex-run-bindings-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const sample = await document(store);
    const api = await store.saveConfig(apiConfig);
    const apiProfile = profile(store, 'chat-completions');
    const firstRun = await task(store, sample.id, api);
    const capturedApiRun = store.rows('SELECT * FROM analysis_runs WHERE id=?', [firstRun])[0];
    const codex = await store.saveConfig(codexConfig);
    const codexProfile = profile(store, 'codex-cli');
    const codexRun = await task(store, sample.id, codex);
    const delayedApiRun = await task(store, sample.id, api); // API profile is disabled now.
    await store.saveConfig({ ...apiConfig, provider: 'chat-completions', name: '切回API后的新名称' });
    const delayedCodexRun = await task(store, sample.id, codex); // Codex profile is disabled now.
    const localRun = await task(store, sample.id, codex, 'local');
    assert.deepEqual(store.rows('SELECT * FROM analysis_runs WHERE id=?', [firstRun])[0], capturedApiRun);
    const expected = new Map([[firstRun, ['chat-completions', apiProfile.id, api]],
      [codexRun, ['codex-cli', codexProfile.id, codex]], [delayedApiRun, ['chat-completions', apiProfile.id, api]],
      [delayedCodexRun, ['codex-cli', codexProfile.id, codex]]]);
    for (const [runId, [adapter, providerId, config]] of expected) {
      const row: ReturnType<AppStore['rows']>[number] = store.rows('SELECT r.model_provider_profile_id,r.model_snapshot_json,p.adapter_id FROM analysis_runs r JOIN provider_profiles p ON p.id=r.model_provider_profile_id WHERE r.id=?', [runId])[0];
      assert.equal(row.adapter_id, adapter); assert.equal(row.model_provider_profile_id, providerId);
      assert.deepEqual(JSON.parse(String(row.model_snapshot_json)), config);
    }
    const local = store.rows('SELECT r.model_snapshot_json,p.adapter_id FROM analysis_runs r JOIN provider_profiles p ON p.id=r.model_provider_profile_id WHERE r.id=?', [localRun])[0];
    assert.equal(local.adapter_id, 'local-rules'); assert.deepEqual(JSON.parse(String(local.model_snapshot_json)), { adapter: 'local-rules' });
    await store.close(); store = await AppStore.open(dir);
    const restored = store.rows('SELECT r.model_snapshot_json,p.adapter_id FROM analysis_runs r JOIN provider_profiles p ON p.id=r.model_provider_profile_id WHERE r.id=?', [codexRun])[0];
    assert.equal(restored.adapter_id, 'codex-cli'); assert.deepEqual(JSON.parse(String(restored.model_snapshot_json)), codex);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('模型持久化显式限字段，Codex和API都不保存认证值或未知字段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-codex-no-auth-copy-')); let store: AppStore | undefined;
  const secrets = ['synthetic-api-secret', 'synthetic-access-token', 'synthetic-refresh-token'];
  try {
    store = await AppStore.open(dir);
    for (const config of [apiConfig, codexConfig]) {
      await store.saveConfig({ ...config, apiKey: secrets[0], clearApiKey: true, access_token: secrets[1], refreshToken: secrets[2] } as ModelConfigInput);
      const saved: PublicModelConfig = store.getConfig()!;
      assert.equal('apiKey' in saved, false); assert.equal('clearApiKey' in saved, false);
      assert.equal('access_token' in saved, false); assert.equal('refreshToken' in saved, false);
    }
    const rows = JSON.stringify(store.rows('SELECT * FROM provider_profiles'));
    for (const secret of secrets) assert.equal(rows.includes(secret), false);
    await store.close(); store = undefined;
    const bytes = await readFile(join(dir, 'workspace.sqlite'));
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});
