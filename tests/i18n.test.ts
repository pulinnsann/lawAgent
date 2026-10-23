import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, useI18n, translate, translateKnownMessage, formatInterfaceDate, formatInterfaceNumber, readInterfaceLocale, INTERFACE_LOCALE_STORAGE_KEY } from '../src/renderer/src/i18n';
import { interfaceMessages } from '../src/renderer/src/i18n-messages';

test('all interface dictionaries have nonempty English/Thai and preserve interpolation parameters', () => {
  assert.ok(Object.keys(interfaceMessages).length > 1700);
  const params = (value: string) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
  for (const [key, value] of Object.entries(interfaceMessages)) {
    assert.ok(value.en.trim(), `English missing: ${key}`); assert.ok(value.th.trim(), `Thai missing: ${key}`);
    assert.deepEqual(params(value.en), params(key), `English parameters: ${key}`);
    assert.deepEqual(params(value.th), params(key), `Thai parameters: ${key}`);
  }
});

test('static source translation calls are covered rather than silently falling back to Chinese', async () => {
  const root = new URL('../src/renderer/src/', import.meta.url);
  for (const file of (await readdir(root)).filter(file => file.endsWith('.tsx') && file !== 'i18n.tsx')) {
    const source = await readFile(new URL(file, root), 'utf8');
    const strings = source.matchAll(/\bt\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g);
    for (const match of strings) {
      const literal = match[1];
      const key = literal[0] === '"' ? JSON.parse(literal) as string : literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      assert.ok(interfaceMessages[key], `${file}: no translation for ${key}`);
    }
  }
});

test('interpolation preserves user values literally and does not recursively translate or evaluate them', () => {
  const input = '用户原文 <script>test</script> {v1} $&';
  assert.equal(translate('en', '来源版本：{v0}', { v0: input }), `Source version: ${input}`);
  assert.equal(translate('th', '来源版本：{v0}', { v0: input }), `รุ่นต้นทาง: ${input}`);
  assert.equal(translate('zh', '来源版本：{v0}', { v0: input }), `来源版本：${input}`);
  assert.equal(translate('en', 'unknown raw user content'), 'unknown raw user content');
});

test('known notifications change language but unknown backend errors remain available verbatim', () => {
  assert.equal(translateKnownMessage('en', '项目已保存。'), 'Project saved.');
  assert.equal(translateKnownMessage('th', 'Project saved.'), 'บันทึกโครงการแล้ว');
  assert.equal(translateKnownMessage('en', '软件内置运行环境可用（25.8.1），无需另行安装。'), 'Bundled runtime is ready (25.8.1); no separate installation needed.');
  const raw = '自定义错误：原始材料内容不能自动翻译 429';
  assert.equal(translateKnownMessage('th', raw), raw);
  const dynamic = translate('en', '来源版本：{v0}', { v0: 'user-合同版本' });
  assert.equal(translateKnownMessage('th', dynamic), 'รุ่นต้นทาง: user-合同版本');
});

test('locale preference is versioned and resilient to unavailable/invalid storage', () => {
  assert.match(INTERFACE_LOCALE_STORAGE_KEY, /\.v1$/);
  assert.equal(readInterfaceLocale({ getItem: key => key === INTERFACE_LOCALE_STORAGE_KEY ? 'th' : null }), 'th');
  assert.equal(readInterfaceLocale({ getItem: () => 'fr' }), 'zh');
  assert.equal(readInterfaceLocale({ getItem: () => { throw new Error('blocked'); } }), 'zh');
});

test('Thai interface uses Gregorian dates and Latin digits and currency formatting never converts values', () => {
  const formatted = formatInterfaceDate('th', '2026-10-23T00:00:00Z', { timeZone: 'UTC' });
  assert.match(formatted, /2026/); assert.doesNotMatch(formatted, /2569|[๐-๙]/);
  assert.equal(formatInterfaceDate('en', 'invalid date'), 'invalid date');
  const number = 1234.56;
  assert.equal(formatInterfaceNumber('en', number, { maximumFractionDigits: 2 }), '1,234.56');
  assert.match(formatInterfaceNumber('th', number, { style: 'currency', currency: 'THB' }), /1,234\.56/);
  assert.equal(number, 1234.56);
});

test('React localization is source-based and escapes user data without altering contract or report content', () => {
  const userText = '中国合同 <b>用户正文</b> ภาษาไทย';
  function Fixture() { const { t } = useI18n(); return createElement('section', null, createElement('button', { 'aria-label': t('保存配置') }, t('保存配置')), createElement('pre', null, userText)); }
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children: createElement(Fixture) }));
  assert.ok(html.includes(translate('en', '保存配置'))); assert.match(html, /中国合同 &lt;b&gt;用户正文&lt;\/b&gt; ภาษาไทย/);
  assert.equal(userText, '中国合同 <b>用户正文</b> ภาษาไทย');
});
