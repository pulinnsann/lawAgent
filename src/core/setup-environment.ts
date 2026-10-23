import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { EnvironmentCheck, EnvironmentReport } from '../shared/setup';
import { knowledgeQuery, tokenizeKnowledgeText } from './knowledge-tokenizer';

/** Fixed, local-only checks. Never executes a shell or downloads dependencies. */
export async function runEnvironmentProbe(dataDir: string): Promise<EnvironmentReport> {
  const checks: EnvironmentCheck[] = [];
  const add = (id: EnvironmentCheck['id'], label: string, passed: boolean, message: string) => checks.push({ id, label, status: passed ? 'passed' : 'failed', message });
  const runtimeReady = Number(process.versions.node.split('.')[0]) >= 24;
  add('runtime', '内置运行环境', runtimeReady, runtimeReady ? `软件内置运行环境可用（${process.versions.node}），无需另行安装。` : `当前运行环境 ${process.versions.node} 不符合要求，请使用完整桌面版本。`);
  let temporary: string | null = null;
  try {
    await mkdir(dataDir, { recursive: true });
    temporary = await mkdtemp(join(dataDir, '.setup-check-'));
    const path = join(temporary, 'read-write.txt'); const text = '本机环境配置检查 / local setup / ตรวจสอบ';
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
    if (await readFile(path, 'utf8') !== text) throw new Error('本地文件读回不一致');
    for (const directory of ['documents', 'exports', 'local-knowledge']) {
      const destination = join(dataDir, directory); await mkdir(destination, { recursive: true });
      const marker = join(destination, `.setup-check-${randomUUID()}`);
      try { await writeFile(marker, text, { flag: 'wx', mode: 0o600 }); if (await readFile(marker, 'utf8') !== text) throw new Error('子目录读回不一致'); }
      finally { await rm(marker, { force: true }); }
    }
    add('storage', '本机数据目录', true, '读写检查通过，合同、报告和索引目录已准备好。');
  } catch {
    add('storage', '本机数据目录', false, '本机数据目录无法读写，请检查目录权限、磁盘空间及软件安装位置。');
  }
  try {
    if (Intl.Segmenter.supportedLocalesOf(['zh', 'en', 'th']).length !== 3) throw new Error('缺少三语数据');
    for (const [language, text] of [['zh', '合同验收付款'], ['en', 'Contract acceptance payment'], ['th', 'การชำระเงินตามสัญญา']]) {
      const segments = [...new Intl.Segmenter(language, { granularity: 'word' }).segment(text)];
      if (!segments.some(segment => segment.isWordLike)) throw new Error('分词结果为空');
    }
    add('languages', '中英泰文字处理', true, '三种语言的本地分词数据可用，检索原文无需预先翻译。');
  } catch { add('languages', '中英泰文字处理', false, '当前运行环境缺少三语分词能力，请使用完整桌面版本。'); }
  if (temporary) {
    let database: DatabaseSync | null = null;
    try {
      const path = join(temporary, 'probe.sqlite');
      database = new DatabaseSync(path, { allowExtension: false });
      database.exec('PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE probe USING fts5(content);');
      database.prepare('INSERT INTO probe(content) VALUES(?)').run(tokenizeKnowledgeText('验收付款 payment ชำระเงิน'));
      const query = knowledgeQuery('验收');
      if (!query.match || !database.prepare('SELECT rowid FROM probe WHERE probe MATCH ? ORDER BY rank').get(query.match)) throw new Error('全文检索未命中');
      database.close(); database = null; database = new DatabaseSync(path, { allowExtension: false });
      if (Number(database.prepare('SELECT count(*) AS n FROM probe').get()?.n) !== 1) throw new Error('持久读回失败');
      add('fts5', '本地全文索引', true, '磁盘索引创建、检索及关闭后重新读取均通过。');
    } catch { add('fts5', '本地全文索引', false, '全文索引自检失败，请检查完整软件版本和本机数据目录。'); }
    finally { database?.close(); }
    try { await rm(temporary, { recursive: true, force: true }); }
    catch {
      const storage = checks.find(check => check.id === 'storage');
      if (storage) { storage.status = 'failed'; storage.message = '数据目录可读写，但临时检查文件无法清理，请检查目录权限。'; }
    }
  } else checks.push({ id: 'fts5', label: '本地全文索引', status: 'unavailable', message: '数据目录不可写，未执行磁盘索引检查。' });
  return { checkedAt: new Date().toISOString(), isPreview: false, ready: checks.every(check => check.status === 'passed'), checks };
}
