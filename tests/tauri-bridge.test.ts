import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import type { ContractAssistantBridge, ReviewTask } from '../src/shared/contracts';
import { createTauriBridgeSession, installTauriBridge, isTauriDesktop, type DesktopCommandResponse, type TauriBridgeTransport } from '../src/renderer/src/tauri-bridge';

const serialized = (value: unknown) => JSON.parse(JSON.stringify(value));

async function referencePreload() {
  const commands: unknown[] = [];
  const events = new EventEmitter();
  let bridge: ContractAssistantBridge | undefined;
  const source = (await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')).replace(/^import .+;\r?\n/gmu, '');
  const code = stripTypeScriptTypes(source);
  new Function('contextBridge', 'ipcRenderer', code)(
    { exposeInMainWorld(name: string, value: ContractAssistantBridge) { assert.equal(name, 'contractAssistant'); bridge = value; } },
    { invoke(channel: string, input: unknown) { assert.equal(channel, 'contract-assistant:command'); commands.push(serialized(input)); return Promise.resolve({ ok: true, data: { received: true } }); }, on: events.on.bind(events), removeListener: events.removeListener.bind(events) },
  );
  assert.ok(bridge);
  return { bridge, commands, events };
}

function fakeTransport() {
  const commands: unknown[] = [];
  let event: ((event: { payload: ReviewTask }) => void) | undefined;
  let unsubscriptions = 0;
  let response: DesktopCommandResponse = { ok: true, data: { received: true } };
  let rejected: unknown;
  const transport: TauriBridgeTransport = {
    async invoke(name, input) { assert.equal(name, 'desktop_invoke'); commands.push(serialized(input)); if (rejected !== undefined) throw rejected; return response; },
    async listen(name, callback) { assert.equal(name, 'desktop-task'); event = callback; return () => { unsubscriptions++; }; },
  };
  return { transport, commands, emit(task: ReviewTask) { event?.({ payload: task }); }, setResponse(value: DesktopCommandResponse) { response = value; }, reject(value: unknown) { rejected = value; }, get unsubscriptions() { return unsubscriptions; } };
}

test('every Tauri method preserves the actual Electron preload command and arguments', async () => {
  const reference = await referencePreload();
  const fake = fakeTransport(); const session = await createTauriBridgeSession(fake.transport);
  const actualNames = Object.keys(session.bridge).sort();
  assert.deepEqual(actualNames, Object.keys(reference.bridge).sort());
  for (const name of actualNames.filter(name => name !== 'onTaskUpdate')) {
    // Distinct arguments detect accidental position changes in two-argument commands.
    for (const args of [[], [{ sentinel: name, nested: ['中文', 'English', 'ภาษาไทย', '😀'] }, 'second-argument']]) {
      const expected = await Reflect.apply(reference.bridge[name as keyof ContractAssistantBridge], reference.bridge, args);
      const actual = await Reflect.apply(session.bridge[name as keyof ContractAssistantBridge], session.bridge, args);
      assert.deepEqual(actual, expected, `${name}: result`);
      assert.deepEqual(fake.commands.at(-1), reference.commands.at(-1), `${name}: serialized command`);
    }
  }
  session.dispose();
});

test('task subscriptions are ready before bridge exposure and independent on disposal', async () => {
  const fake = fakeTransport(); const session = await createTauriBridgeSession(fake.transport);
  const received: ReviewTask[] = [];
  const task: ReviewTask = { id: 'task', documentId: 'document', status: 'running', stage: 'Reviewing', startedAt: '2026-10-26T00:00:00Z', finishedAt: null, error: null, resultId: null };
  const callback = (value: ReviewTask) => received.push(value);
  const first = session.bridge.onTaskUpdate(callback);
  const second = session.bridge.onTaskUpdate(callback);
  fake.emit(task); assert.equal(received.length, 2);
  first(); first(); fake.emit(task); assert.equal(received.length, 3);
  second(); fake.emit(task); assert.equal(received.length, 3);
  session.bridge.onTaskUpdate(callback);
  session.dispose(); session.dispose(); fake.emit(task);
  assert.equal(received.length, 3); assert.equal(fake.unsubscriptions, 1);
  await assert.rejects(session.bridge.getState(), /connection is closed/u);
});

test('host failures and rejected transport strings are readable errors without payload leakage', async () => {
  const fake = fakeTransport(); const { bridge, dispose } = await createTauriBridgeSession(fake.transport);
  fake.setResponse({ ok: false, error: 'The workspace is locked.' });
  await assert.rejects(bridge.getState(), { name: 'Error', message: 'The workspace is locked.' });
  fake.setResponse({ ok: false });
  await assert.rejects(bridge.getState(), /Desktop operation failed/u);
  fake.setResponse(null as unknown as DesktopCommandResponse);
  await assert.rejects(bridge.getState(), /Invalid desktop response/u);
  fake.reject('Native backend stopped.');
  await assert.rejects(bridge.getState(), { name: 'Error', message: 'Native backend stopped.' });
  fake.reject({ message: 'Operation cancelled.' });
  await assert.rejects(bridge.getState(), { name: 'Error', message: 'Operation cancelled.' });
  dispose();
});

test('browser preview and existing Electron bridge are retained without accessing Tauri APIs', async () => {
  assert.equal(isTauriDesktop({} as Window), false);
  assert.equal(isTauriDesktop({ __TAURI_INTERNALS__: {} } as unknown as Window), true);
  const browser = {} as Window; await installTauriBridge(browser); assert.equal(browser.contractAssistant, undefined);
  const fake = fakeTransport(); const session = await createTauriBridgeSession(fake.transport);
  const electron = { contractAssistant: session.bridge } as Window;
  await installTauriBridge(electron); assert.equal(electron.contractAssistant, session.bridge);
  const existing = { __TAURI_INTERNALS__: {}, contractAssistant: session.bridge } as unknown as Window;
  await installTauriBridge(existing); assert.equal(existing.contractAssistant, session.bridge);
  session.dispose();
});
