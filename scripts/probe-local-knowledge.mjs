import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Synthetic fixtures only. This probe never reads customer folders, credentials or remote services.
const started = performance.now();
const report = {
  probeVersion: '1',
  runtime: { execPath: process.execPath, node: process.versions.node, electron: process.versions.electron ?? null,
    v8: process.versions.v8, icu: process.versions.icu ?? null, platform: process.platform, arch: process.arch },
  sqlite: { available: false }, segmenter: {}, checks: {}, errors: [],
  limitations: [
    'Synthetic local-disk fixtures; no Windows, SMB, NAS, SFTP or 1 TB run is performed.',
    'This validates indexing/runtime primitives, not DOCX/PDF extraction, OCR or legal retrieval quality.',
    'Custom terms use application-side longest matching; Intl.Segmenter has no dictionary argument.',
    'No embeddings, ANN engine, production migration or user-facing feature is implemented.',
  ],
};
const checks = report.checks;
const hash = value => createHash('sha256').update(value).digest('hex');
const terms = ['统一社会信用代码', '知识产权', '验收标准', '销售报告', 'intellectual property', 'force majeure', 'ชำระเงิน', 'การตรวจรับ'];
const samples = {
  zh: { locale: 'zh-CN', text: '合同约定统一社会信用代码与知识产权保护，验收标准见附件。', requiredTerms: ['统一社会信用代码','知识产权','验收标准'] },
  en: { locale: 'en', text: 'The supplier shall protect intellectual property and define force majeure.', requiredTerms: ['intellectual property','force majeure'] },
  th: { locale: 'th', text: 'ผู้ซื้อจะต้องชำระเงินหลังการตรวจรับตามสัญญา', requiredTerms: ['ชำระเงิน','การตรวจรับ'] },
};

function segment(text, locale) {
  return [...new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)]
    .filter(part => part.isWordLike)
    .map(part => ({ text: part.segment, start: part.index, end: part.index + part.segment.length, custom: false }));
}

/** Keep original UTF-16 offsets; custom matching never replaces or normalizes source text. */
function segmentWithTerms(text, locale) {
  const matches = [];
  for (const term of terms) {
    let cursor = 0;
    while ((cursor = text.indexOf(term, cursor)) !== -1) { matches.push({ text: term, start: cursor, end: cursor + term.length, custom: true }); cursor += term.length; }
  }
  matches.sort((a,b) => a.start - b.start || b.end - a.end);
  const selected = []; let through = 0;
  for (const match of matches) if (match.start >= through) { selected.push(match); through = match.end; }
  const tokens = []; let cursor = 0;
  for (const match of selected) {
    tokens.push(...segment(text.slice(cursor, match.start), locale).map(part => ({ ...part, start: part.start + cursor, end: part.end + cursor })));
    tokens.push(match); cursor = match.end;
  }
  tokens.push(...segment(text.slice(cursor), locale).map(part => ({ ...part, start: part.start + cursor, end: part.end + cursor })));
  return tokens;
}

function searchable(text, locale) { return segmentWithTerms(text, locale).map(part => part.text.toLowerCase()).join(' '); }
function phrase(term) { return `"${term.toLowerCase().replaceAll('"','""')}"`; }

/** Fixture chunking only: paragraphs plus a bounded hard split; not a production chunker. */
function chunks(text, limit = 1000) {
  const result = []; let offset = 0;
  for (const paragraph of text.split('\n')) {
    for (let start = 0; start < paragraph.length; start += limit) {
      const value = paragraph.slice(start, start + limit);
      if (value.trim()) result.push({ text: value, start: offset + start, end: offset + start + value.length });
    }
    offset += paragraph.length + 1;
  }
  return result;
}

let directory;
let db;
let reader;
try {
  if (typeof Intl.Segmenter !== 'function') throw new Error('Intl.Segmenter is unavailable.');
  for (const [language, sample] of Object.entries(samples)) {
    const base = segment(sample.text, sample.locale);
    const custom = segmentWithTerms(sample.text, sample.locale);
    report.segmenter[language] = {
      requestedLocale: sample.locale,
      supportedLocales: Intl.Segmenter.supportedLocalesOf([sample.locale]),
      resolvedLocale: new Intl.Segmenter(sample.locale, { granularity:'word' }).resolvedOptions().locale,
      original: sample.text, baselineTokens: base.map(part=>part.text),
      customTokens: custom.map(part=>part.text), customTerms: custom.filter(part=>part.custom).map(part=>part.text),
      offsets: 'UTF-16 code units, half-open; convert before using code-point-based application locators',
    };
    checks[`segmenter_${language}`] = Intl.Segmenter.supportedLocalesOf([sample.locale]).length === 1
      && custom.every(part=>sample.text.slice(part.start,part.end) === part.text)
      && sample.requiredTerms.every(term=>custom.some(part=>part.text === term));
  }
  const mixed = `${samples.zh.text} ${samples.en.text} ${samples.th.text}`;
  const mixedTokens = segmentWithTerms(mixed,'zh-CN');
  checks.segmenter_mixed_custom_terms = Object.values(samples).flatMap(sample=>sample.requiredTerms).every(term=>mixedTokens.some(token=>token.text === term));

  let sqlite;
  try { sqlite = await import('node:sqlite'); report.sqlite.available = true; }
  catch (error) { throw new Error(`node:sqlite unavailable: ${error instanceof Error ? error.message : 'import failed'}`); }
  directory = await mkdtemp(join(tmpdir(),'law-agent-local-kb-probe-'));
  const dbPath = join(directory,'index.sqlite');
  db = new sqlite.DatabaseSync(dbPath);
  report.sqlite.version = db.prepare('SELECT sqlite_version() AS version').get().version;
  report.sqlite.compileOptions = db.prepare('PRAGMA compile_options').all().map(row=>Object.values(row)[0]);
  report.sqlite.journalMode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  checks.wal_enabled = report.sqlite.journalMode === 'wal';
  db.exec(`
    CREATE TABLE sources(id TEXT PRIMARY KEY, uri TEXT NOT NULL, content_sha256 TEXT NOT NULL, locale TEXT NOT NULL);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, start_utf16 INTEGER NOT NULL, end_utf16 INTEGER NOT NULL,
      original_text TEXT NOT NULL, search_terms TEXT NOT NULL, UNIQUE(source_id,ordinal));
    CREATE VIRTUAL TABLE chunks_fts USING fts5(search_terms, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 0');
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid,search_terms) VALUES(new.id,new.search_terms); END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts,rowid,search_terms) VALUES('delete',old.id,old.search_terms); END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts,rowid,search_terms) VALUES('delete',old.id,old.search_terms);
      INSERT INTO chunks_fts(rowid,search_terms) VALUES(new.id,new.search_terms); END;
    CREATE VIRTUAL TABLE raw_fts USING fts5(body);
  `);
  checks.disk_fts5_created = true;
  const insertSource = db.prepare('INSERT INTO sources(id,uri,content_sha256,locale) VALUES(?,?,?,?)');
  const insertChunk = db.prepare('INSERT INTO chunks(source_id,ordinal,start_utf16,end_utf16,original_text,search_terms) VALUES(?,?,?,?,?,?)');
  const search = query => db.prepare(`SELECT c.id,c.source_id,c.ordinal,c.start_utf16,c.end_utf16,c.original_text,
    bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid
    WHERE chunks_fts MATCH ? ORDER BY score,c.id LIMIT 5`).all(phrase(query));
  async function ingest(id,text,locale) {
    const path = join(directory,`${id}.txt`); await writeFile(path,text,{mode:0o600});
    const original = await readFile(path,'utf8');
    db.exec('BEGIN');
    try {
      insertSource.run(id,pathToFileURL(path).toString(),hash(original),locale);
      chunks(original).forEach((chunk,index)=>insertChunk.run(id,index,chunk.start,chunk.end,chunk.text,searchable(chunk.text,locale)));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return original;
  }
  const deepText = Array.from({length:300},(_,index)=>`第${index+1}段：此段描述普通合同背景及业务说明，不含目标短语。`).join('\n')
    + '\n第301条：验收标准为双方确认的测试记录；付款另行约定。';
  await ingest('deep',deepText,'zh-CN');
  await ingest('zh',samples.zh.text,'zh-CN');
  await ingest('en',samples.en.text,'en');
  await ingest('th',samples.th.text,'th');
  const deepHit = search('验收标准').find(row=>row.source_id === 'deep');
  checks.deep_original_hit = Boolean(deepHit && deepHit.start_utf16 > 500 && deepHit.original_text.includes('验收标准')
    && deepText.slice(deepHit.start_utf16,deepHit.end_utf16) === deepHit.original_text);
  report.deepHit = deepHit ? { sourceId: deepHit.source_id, paragraphOrdinal: deepHit.ordinal, originalStartUtf16: deepHit.start_utf16,
    originalExcerpt: deepHit.original_text, rankedBy:'bm25 ascending', originalSha256:hash(deepText) } : null;
  report.retrieval = {};
  for (const [language,sample] of Object.entries(samples)) {
    const queries = sample.requiredTerms;
    const matches = queries.map(query=>({query,sourceIds:search(query).map(row=>row.source_id)}));
    checks[`fts_segmented_${language}`] = matches.every(match=>match.sourceIds.includes(language));
    report.retrieval[language] = matches;
  }
  const baseline = db.prepare('INSERT INTO raw_fts(body) VALUES(?)');
  baseline.run('这份销售报告显示增长'); baseline.run(samples.th.text);
  report.rawUnicode61Baseline = ['销售报告','ชำระเงิน'].map(query=>({query,hits:db.prepare('SELECT count(*) AS count FROM raw_fts WHERE raw_fts MATCH ?').get(phrase(query)).count}));
  // Raw misses are observations, not a requirement: they must not be misreported as FTS5 incapability.
  checks.ranked_results_monotonic = search('验收标准').every((row,index,rows)=>index===0 || rows[index-1].score <= row.score);

  await ingest('mutable','legacyterm is present','en');
  checks.insert_visible = search('legacyterm').some(row=>row.source_id==='mutable');
  db.prepare('UPDATE chunks SET original_text=?,search_terms=? WHERE source_id=?').run('replacementterm is present',searchable('replacementterm is present','en'),'mutable');
  checks.update_sync = search('legacyterm').length===0 && search('replacementterm').some(row=>row.source_id==='mutable');
  db.prepare('DELETE FROM sources WHERE id=?').run('mutable');
  checks.delete_cascade_sync = search('replacementterm').length===0 && db.prepare('SELECT count(*) AS count FROM chunks WHERE source_id=?').get('mutable').count===0;

  reader = new sqlite.DatabaseSync(dbPath);
  reader.exec('PRAGMA busy_timeout=5000; BEGIN;');
  const before = reader.prepare('SELECT count(*) AS count FROM sources').get().count;
  await ingest('wal-write','walwriterterm','en');
  const during = reader.prepare('SELECT count(*) AS count FROM sources').get().count;
  reader.exec('COMMIT');
  const after = reader.prepare('SELECT count(*) AS count FROM sources').get().count;
  checks.wal_reader_snapshot_writer_commit = during===before && after===before+1;
  report.sqlite.readerSnapshot = { before,during,after };
  report.sqlite.walFileBytesWhileOpen = (await stat(`${dbPath}-wal`)).size;
  checks.wal_file_exists = report.sqlite.walFileBytesWhileOpen > 0;
  reader.close(); reader=undefined;
  db.exec("INSERT INTO chunks_fts(chunks_fts,rank) VALUES('integrity-check',1)");
  checks.fts_external_content_integrity = true;
  checks.foreign_keys = db.prepare('PRAGMA foreign_key_check').all().length===0;
  checks.sqlite_integrity = db.prepare('PRAGMA integrity_check').get().integrity_check==='ok';
  report.fixture = { originalSourceCount:db.prepare('SELECT count(*) AS count FROM sources').get().count,
    chunkCount:db.prepare('SELECT count(*) AS count FROM chunks').get().count,
    originalTextBytes:Buffer.byteLength(deepText+Object.values(samples).map(sample=>sample.text).join('')+'walwriterterm','utf8'),
    dictionaryVersion:'probe-dictionary-v1', persistentCorpus:false };
  db.close(); db=undefined;
  const reopened = new sqlite.DatabaseSync(dbPath); db=reopened;
  const reopenedHit = reopened.prepare(`SELECT c.source_id,c.original_text FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid
    WHERE chunks_fts MATCH ?`).all(phrase('ชำระเงิน'));
  checks.persistence_reopen = reopenedHit.some(row=>row.source_id==='th')
    && reopened.prepare("SELECT count(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'replacementterm'").get().count===0
    && reopened.prepare("SELECT count(*) AS count FROM chunks_fts WHERE chunks_fts MATCH 'walwriterterm'").get().count===1;
  checks.wal_mode_persisted = reopened.prepare('PRAGMA journal_mode').get().journal_mode==='wal';
  report.sqlite.diskBytesAfterReopen = (await stat(dbPath)).size;
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : String(error));
} finally {
  try { reader?.close(); } catch { /* best effort probe cleanup */ }
  try { db?.close(); } catch { /* best effort probe cleanup */ }
  if (directory) {
    try { await rm(directory,{recursive:true,force:true}); report.temporaryDirectoryRemoved=true; }
    catch (error) { report.errors.push(`Temporary cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  report.elapsedMs=Math.round(performance.now()-started);
  report.failedChecks=Object.entries(checks).filter(([,value])=>value!==true).map(([name])=>name);
  report.ok=report.errors.length===0 && report.failedChecks.length===0 && report.sqlite.available && checks.disk_fts5_created===true;
  console.log(JSON.stringify(report,null,2));
  if (!report.ok) process.exitCode=1;
}
