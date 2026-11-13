/* Thai ⇄ English product search */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/lib/search-terms');

const groupsOf = (q) => S.parse(q).groups.map((g) => g[0]);

test('Thai words find English product names', () => {
  assert.deepEqual(groupsOf('เดรส'), ['dress']);
  assert.deepEqual(groupsOf('ดอกไม้').sort(), ['floral']);
  assert.deepEqual(groupsOf('สีขาว'), ['white']);
  assert.deepEqual(groupsOf('ขาว'), ['white']);
  assert.deepEqual(groupsOf('ดำ'), ['black']);
  assert.deepEqual(groupsOf('เดรสสีขาว ลายดอก').sort(), ['dress', 'floral', 'white']);
  assert.deepEqual(groupsOf('กางเกงขาสั้นยีนส์').sort(), ['jeans', 'shorts']);  // longest match: not "กางเกง"
  assert.deepEqual(groupsOf('ชุดสีน้ำเงินเข้ม'), ['navy']);                  // not "blue"
});

test('English still works and unknown words are searched as typed', () => {
  assert.deepEqual(S.parse('White Dress'), { groups: [S.GROUPS.find((g) => g[0] === 'dress'), S.GROUPS.find((g) => g[0] === 'white')], literals: [] });
  assert.deepEqual(S.parse('Dottie top').literals, ['dottie']);
  assert.deepEqual(S.parse('ชุดสีขาว').literals, []);     // filler words dropped
  assert.deepEqual(S.parse('เดรสสวยๆ').literals, []);
});

test('SQL: every term must match, any synonym', () => {
  const params = {};
  const r = S.sqlFor('เดรสดำ', params);
  assert.equal(r.terms, 2);
  assert.match(r.sql, / AND /);
  assert.ok(Object.values(params).includes('%dress%') && Object.values(params).includes('%black%') && Object.values(params).includes('%ดำ%'));
});
