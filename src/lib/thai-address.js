'use strict';
/**
 * Thai address hierarchy: province → district (เขต/อำเภอ) → subdistrict (แขวง/ตำบล) → [postcodes]
 * Data: public/data/th-address.json (generated from the `thai-address-database` package, ISC license).
 * The same file is served to the browser for the cascading dropdowns.
 */
const path = require('path');
const tree = require(path.join(__dirname, '..', '..', 'public', 'data', 'th-address.json'));

const sortTh = (a) => a.sort((x, y) => x.localeCompare(y, 'th'));

/** Dropdown options for the levels below the currently selected values. */
function options(f = {}) {
  const p = tree[f.province] || {};
  const d = p[f.district] || {};
  return {
    districts: sortTh(Object.keys(p)),
    subdistricts: sortTh(Object.keys(d)),
    postcodes: d[f.subdistrict] || [],
  };
}

/** Returns an errors object for the address fields (empty when valid). */
function validate(f) {
  const e = {};
  const p = tree[f.province];
  if (!p) { e.province = 'กรุณาเลือกจังหวัด'; return e; }
  const d = p[f.district];
  if (!d) { e.district = 'กรุณาเลือกเขต/อำเภอ'; return e; }
  const zips = d[f.subdistrict];
  if (!zips) { e.subdistrict = 'กรุณาเลือกแขวง/ตำบล'; return e; }
  if (!zips.includes(f.postcode)) e.postcode = 'กรุณาเลือกรหัสไปรษณีย์';
  return e;
}

module.exports = { tree, options, validate };
