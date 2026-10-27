import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { interfaceMessages, lawyerInterfaceMessages } from '../src/renderer/src/i18n-messages';
import { translate, translateKnownMessage, I18nProvider, useI18n } from '../src/renderer/src/i18n';

const parameters = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(match => match[1]).sort();
test('lawyer-facing wording keeps all supplied values intact in Chinese, English and Thai', () => {
  assert.ok(Object.keys(lawyerInterfaceMessages).length >= 200);
  for (const [key, value] of Object.entries(lawyerInterfaceMessages)) {
    assert.ok(interfaceMessages[key]);
    for (const locale of ['zh', 'en', 'th'] as const) {
      assert.ok(value[locale].trim());
      assert.deepEqual(parameters(value[locale]), parameters(key), `${locale}: ${key}`);
      const values = Object.fromEntries(parameters(key).map(name => [name, '<user-value> {unchanged} $&']));
      const rendered = translate(locale, key, values);
      for (const name of parameters(key)) assert.ok(rendered.includes(values[name]));
    }
  }
});

test('common tasks use business wording while existing notification keys still resolve', () => {
  assert.equal(translate('zh', '开始模型审核'), '开始智能审核');
  assert.equal(translate('zh', '本地规则检查'), '基础条款检查');
  assert.equal(translate('zh', '个原文块'), '段原文');
  for (const key of ['许可有效', '本地规则检查', '资源与任务状态']) {
    const original = interfaceMessages[key].en;
    assert.equal(translateKnownMessage('zh', original), translate('zh', key));
    assert.equal(translateKnownMessage('en', translate('zh', key)), translate('en', key));
  }
});

test('plain UI copy does not rewrite supplied contracts, source excerpts or saved findings', () => {
  const contract = '第一条：API、索引及 SHA256 系统服务，合同金额人民币 100,000 元。';
  const savedFinding = '已扫描 10 个原文块，形成 2 项关键词待确认提示。';
  function Fixture() {
    const { t } = useI18n();
    return createElement('article', null, createElement('button', null, t('开始模型审核')), createElement('p', null, contract), createElement('p', null, savedFinding));
  }
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'zh', children: createElement(Fixture) }));
  assert.ok(html.includes('开始智能审核')); assert.ok(html.includes(contract)); assert.ok(html.includes(savedFinding));
  assert.equal(translateKnownMessage('en', contract), contract);
  assert.equal(translateKnownMessage('zh', savedFinding), savedFinding);
});
