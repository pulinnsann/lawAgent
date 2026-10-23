/** A bounded, read-only subset of Word automatic numbering. Labels are metadata;
 * no synthetic number is ever inserted into original paragraph text. */
type Node = { [key: string]: Node[] | Record<string, string> | string };
type Nodes = Node[];
const wordNamespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const tag = (node: Node) => Object.keys(node).find(key => key !== ':@' && key !== '#text' && !key.startsWith('?')) ?? '';
const local = (name: string) => name.split(':').at(-1)!;
const children = (node?: Node): Nodes => node && Array.isArray(node[tag(node)]) ? node[tag(node)] as Nodes : [];
function namespaces(nodes: Nodes): Set<string> { const root = nodes.find(node => !tag(node).startsWith('?') && tag(node)); const attrs = root?.[':@']; return new Set(attrs && !Array.isArray(attrs) && typeof attrs === 'object' ? Object.entries(attrs).filter(([key, value]) => key.startsWith('@_xmlns:') && wordNamespaces.has(String(value))).map(([key]) => key.slice('@_xmlns:'.length)) : []); }
function isWord(node: Node, ns: Set<string>): boolean { const name = tag(node), prefix = name.split(':')[0], attributes = node[':@']; const ownNamespace = attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes[`@_xmlns:${prefix}`] : undefined; return name.includes(':') && ns.has(prefix) && (ownNamespace === undefined || wordNamespaces.has(String(ownNamespace))); }
function matching(nodes: Nodes, name: string, ns: Set<string>): Nodes { return nodes.filter(node => local(tag(node)) === name && isWord(node, ns)); }
function first(nodes: Nodes, name: string, ns: Set<string>): Node | undefined { return matching(nodes, name, ns)[0]; }
function attr(node: Node | undefined, name: string, ns: Set<string>): string | undefined { const attrs = node?.[':@']; if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return; const found = Object.entries(attrs).find(([key]) => key.startsWith('@_') && key.includes(':') && ns.has(key.slice(2).split(':')[0]) && local(key) === name); return found && String(found[1]).replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/gu, entity => { const named: Record<string, string> = { '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'" }; if (entity in named) return named[entity]; const code = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3,-1),16) : Number.parseInt(entity.slice(2,-1),10); return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd'; }); }
function integer(value: string | undefined, max = 2147483647): number | undefined { if (!value || !/^\d{1,10}$/u.test(value)) return; const number = Number(value); return Number.isSafeInteger(number) && number <= max ? number : undefined; }
const formats = new Set(['decimal', 'decimalZero', 'chineseCounting', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman']);
interface Level { index: number; start?: number; format?: string; text?: string; restart?: number; legal?: boolean; style?: string; invalid?: boolean }
interface Instance { abstractId: number; levels: Map<number, Partial<Level>>; invalid?: boolean }
interface Abstract { levels: Map<number, Level>; invalid?: boolean }
interface NumPr { id?: number; level?: number; invalid?: boolean }
interface Style { parent?: string; properties: NumPr; invalid?: boolean }
function parseProperties(nodes: Nodes, ns: Set<string>): NumPr {
  const values = matching(nodes, 'numPr', ns); if (!values.length) return {};
  if (values.length !== 1) return { invalid: true };
  const properties = children(values[0]); const numNodes = matching(properties, 'numId', ns), levelNodes = matching(properties, 'ilvl', ns);
  const numId = attr(numNodes[0], 'val', ns), level = attr(levelNodes[0], 'val', ns);
  return { ...(numId !== undefined ? { id: integer(numId) } : {}), ...(level !== undefined ? { level: integer(level, 8) } : {}), invalid: numNodes.length > 1 || levelNodes.length > 1 || numId !== undefined && integer(numId) === undefined || level !== undefined && integer(level, 8) === undefined };
}
function parseLevel(node: Node, ns: Set<string>): Level | null {
  const index = integer(attr(node, 'ilvl', ns), 8); if (index === undefined) return null; const nodes = children(node);
  const property = (name: string) => attr(first(nodes, name, ns), 'val', ns);
  const start = property('start'), restart = property('lvlRestart'), format = property('numFmt'), text = property('lvlText'); const legalNode = first(nodes, 'isLgl', ns), legalValue = attr(legalNode, 'val', ns);
  const style = property('pStyle');
  return { index, ...(start === undefined ? {} : { start: integer(start) }), ...(format === undefined ? {} : { format }), ...(text === undefined ? {} : { text }), ...(restart === undefined ? {} : { restart: integer(restart, index) }), ...(legalNode ? { legal: !['0', 'false', 'off'].includes(legalValue ?? '') } : {}), ...(style ? { style } : {}), invalid: Boolean(start !== undefined && integer(start) === undefined || restart !== undefined && integer(restart, index) === undefined || text && (text.length > 200 || /%(?![1-9])/u.test(text)) || matching(nodes, 'lvlText', ns).length > 1 || matching(nodes, 'numFmt', ns).length > 1) };
}
function formatNumber(number: number, format: string): string | null {
  if (number < 0 || number > 999999) return null;
  if (format === 'decimal' || format === 'decimalZero') return String(number).padStart(format === 'decimalZero' ? 2 : 1, '0');
  if (format.endsWith('Letter')) { if (number < 1 || number > 18278) return null; let result = ''; for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result; return format === 'lowerLetter' ? result.toLowerCase() : result; }
  if (format.endsWith('Roman')) { if (number < 1 || number > 3999) return null; let result = '', value = number; for (const [size, letters] of [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']] as const) while (value >= size) { result += letters; value -= size; } return format === 'lowerRoman' ? result.toLowerCase() : result; }
  if (format === 'chineseCounting') { if (number > 9999) return null; if (!number) return '零'; const digits = '零一二三四五六七八九'; let result = '', zero = false, value = number; for (const [size, suffix] of [[1000,'千'],[100,'百'],[10,'十'],[1,'']] as const) { const count = Math.floor(value / size); value %= size; if (count) { if (zero) result += '零'; result += `${count === 1 && size === 10 && !result ? '' : digits[count]}${suffix}`; zero = false; } else if (result && value) zero = true; } return result; }
  return null;
}

export function createDocxNumbering(input: { numbering: Nodes | null; styles: Nodes | null; main: Nodes; warn: (message: string) => void }) {
  const abstracts = new Map<number, Abstract>(), instances = new Map<number, Instance>(), styles = new Map<string, Style>(); const counters = new Map<number, Array<number | undefined>>(); let defaultStyle: string | undefined;
  const warning = () => input.warn('部分 Word 自动编号定义、样式继承或重启规则无法可靠还原；编号未拼入原文，相关条款引用需人工核对。');
  const numberingNs = namespaces(input.numbering ?? []), stylesNs = namespaces(input.styles ?? []), mainNs = namespaces(input.main);
  const numberRoot = first(input.numbering ?? [], 'numbering', numberingNs); const rootChildren = children(numberRoot);
  const definitions = matching(rootChildren, 'abstractNum', numberingNs), nums = matching(rootChildren, 'num', numberingNs);
  if (definitions.length > 2000 || nums.length > 2000) warning();
  else {
    for (const node of definitions) { const key = integer(attr(node, 'abstractNumId', numberingNs)); if (key === undefined) continue; const nodes = children(node), levels = new Map<number, Level>(); let invalid = Boolean(first(nodes, 'numStyleLink', numberingNs) || first(nodes, 'styleLink', numberingNs)); const attrs = node[':@']; if (attrs && !Array.isArray(attrs) && typeof attrs === 'object' && Object.entries(attrs).some(([key,value]) => local(key) === 'restartNumberingAfterBreak' && ['1','true','on'].includes(String(value)))) invalid = true;
      for (const child of matching(nodes, 'lvl', numberingNs)) { const level = parseLevel(child, numberingNs); if (!level || levels.has(level.index)) { invalid = true; continue; } levels.set(level.index, level); }
      if (abstracts.has(key)) abstracts.get(key)!.invalid = true; else abstracts.set(key, { levels, invalid });
    }
    for (const node of nums) { const key = integer(attr(node, 'numId', numberingNs)), abstractId = integer(attr(first(children(node), 'abstractNumId', numberingNs), 'val', numberingNs)); if (key === undefined || abstractId === undefined) continue; const overrides = new Map<number, Partial<Level>>(); let invalid = matching(children(node), 'abstractNumId', numberingNs).length !== 1;
      for (const child of matching(children(node), 'lvlOverride', numberingNs)) { const index = integer(attr(child, 'ilvl', numberingNs), 8); if (index === undefined || overrides.has(index)) { invalid = true; continue; } const nested = first(children(child), 'lvl', numberingNs); const level = nested ? parseLevel(nested, numberingNs) : { index }; const startNode = first(children(child), 'startOverride', numberingNs), start = startNode && integer(attr(startNode, 'val', numberingNs)); if (!level || level.index !== index || startNode && start === undefined || matching(children(child),'lvl',numberingNs).length > 1 || matching(children(child),'startOverride',numberingNs).length > 1) { invalid = true; continue; } overrides.set(index, { ...level, ...(startNode ? { start } : {}) }); }
      if (instances.has(key)) instances.get(key)!.invalid = true; else instances.set(key, { abstractId, levels: overrides, invalid });
    }
  }
  for (const node of matching(children(first(input.styles ?? [], 'styles', stylesNs)), 'style', stylesNs)) { if (attr(node, 'type', stylesNs) !== 'paragraph') continue; const key = attr(node, 'styleId', stylesNs); if (!key) continue; const nodes = children(node), properties = parseProperties(children(first(nodes, 'pPr', stylesNs)), stylesNs), parent = attr(first(nodes, 'basedOn', stylesNs), 'val', stylesNs); if (styles.has(key)) styles.get(key)!.invalid = true; else styles.set(key, { parent, properties }); if (['1','true','on'].includes(attr(node, 'default', stylesNs) ?? '')) defaultStyle = key; }
  const resolveStyle = (key: string | undefined, chain = new Set<string>()): NumPr => { if (!key) return {}; const item = styles.get(key); if (!item) return {}; if (chain.has(key) || chain.size > 32 || item.invalid) return { invalid: true }; const next = new Set(chain); next.add(key); const parent = resolveStyle(item.parent, next); return { ...parent, ...item.properties, invalid: Boolean(parent.invalid || item.properties.invalid) }; };
  return {
    label(paragraph: Nodes, mainStory = true): string | undefined {
      if (matching(paragraph, 'pPr', mainNs).length > 1) { warning(); return; }
      const pPr = first(paragraph, 'pPr', mainNs); const pChildren = children(pPr); const styleName = attr(first(pChildren, 'pStyle', mainNs), 'val', mainNs) ?? defaultStyle; const inherited = resolveStyle(styleName); const direct = parseProperties(pChildren, mainNs); const properties = { ...inherited, ...direct, invalid: Boolean(inherited.invalid || direct.invalid) };
      if (properties.id === 0) return;
      if (properties.invalid || properties.id === undefined && (properties.level !== undefined || matching(pChildren, 'numPr', mainNs).length)) { warning(); return; }
      if (properties.id === undefined) return;
      if (!mainStory) { warning(); return; }
      const instance = instances.get(properties.id), abstract = instance && abstracts.get(instance.abstractId); if (!instance || !abstract || instance.invalid || abstract.invalid) { warning(); return; }
      const levels = new Map([...abstract.levels].map(([index, level]) => [index, { ...level, ...instance.levels.get(index), invalid: Boolean(level.invalid || instance.levels.get(index)?.invalid) }]));
      let styleMatches: number[] = []; const visited = new Set<string>();
      for (let name = styleName; name && !visited.has(name) && visited.size < 33; name = styles.get(name)?.parent) { visited.add(name); styleMatches = [...levels].filter(([, level]) => level.style === name).map(([index]) => index); if (styleMatches.length) break; }
      if (direct.level === undefined && styleMatches.length > 1) { warning(); return; }
      const index = direct.level ?? (styleMatches.length === 1 ? styleMatches[0] : inherited.level ?? 0); const level = levels.get(index);
      if (!level || level.invalid || level.start === undefined || !level.format || !formats.has(level.format) || level.text === undefined || index > 8) { warning(); return; }
      const values = counters.get(properties.id) ?? []; const next = values[index] === undefined ? level.start : values[index]! + 1; values[index] = next;
      for (const [deeper, definition] of levels) if (deeper > index && definition.restart !== 0 && index <= (definition.restart ?? deeper) - 1) values[deeper] = undefined;
      counters.set(properties.id, values); let uncertain = false;
      const label = level.text.replace(/%([1-9])/gu, (_whole, digit: string) => { const target = Number(digit) - 1, previous = levels.get(target); const number = values[target]; if (target > index || number === undefined || !previous || previous.invalid || !previous.format) { uncertain = true; return ''; } const result = formatNumber(number, level.legal ? 'decimal' : previous.format); if (result === null) { uncertain = true; return ''; } return result; });
      if (uncertain || !label.trim() || label.length > 250 || /[\u0000-\u001f\u007f]/u.test(label)) { warning(); return; }
      return label;
    },
  };
}
