'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { convert } = require('../src/converter');

const S = (f) => fs.readFileSync(path.join(__dirname, '..', 'samples', f), 'utf8');

// Hayha accounts -> Polar
let r = convert(S('hayha-account-test.hayha'), { groupName: 'My Group' });
assert.strictEqual(r.to, 'polar-accounts');
let o = JSON.parse(r.outputText).polarExport;
assert.strictEqual(o.kind, 'accounts');
assert.strictEqual(o.accounts[0].type, 'Target');
assert.strictEqual(o.accounts[0].username, 'test1234@taest.com');
assert.strictEqual(o.accounts[0].accountGroup, 'My Group');

// Polar accounts -> Hayha
r = convert(S('polar-account-test.json'));
assert.strictEqual(r.to, 'hayha-accounts');
let a = JSON.parse(r.outputText)[0];
assert.deepStrictEqual(a.site, [{ name: 'Target', value: 'target' }]);
assert.strictEqual(a.status, 'Not Signed In');
assert.strictEqual(a.password, '123456');

// Hayha profiles -> Polar
r = convert(S('hayha-profile-test.hayha'), { groupName: 'G' });
assert.strictEqual(r.to, 'polar-profiles');
let p = JSON.parse(r.outputText).polarExport.profiles[0];
assert.strictEqual(p.name, 'test 1');
assert.strictEqual(p.shippingAddress.name, 'test LLTest');
assert.strictEqual(p.shippingAddress.state, 'California');
assert.strictEqual(p.shippingAddress.postCode, '92127');
assert.strictEqual(p.paymentDetails.cardExpYear, '2034');
assert.strictEqual(p.paymentDetails.cardExpMonth, '06');
assert.strictEqual(p.sameBillingAndShippingAddress, true);
assert.deepStrictEqual(p.billingAddress, p.shippingAddress);

// Polar profiles -> Hayha
r = convert(S('polar-profile-test.json'));
assert.strictEqual(r.to, 'hayha-profiles');
let h = JSON.parse(r.outputText)[0];
assert.strictEqual(h.shipping.firstName, 'test');
assert.strictEqual(h.shipping.lastName, 'ltest');
assert.deepStrictEqual(h.shipping.state, { shortCode: 'CA', name: 'California' });
assert.strictEqual(h.cardInfo.expYear, 2028);
assert.strictEqual(h.cardInfo.expMonth, '01');
assert.strictEqual(h.sameAsBilling, true);
assert.strictEqual(h.encrypted, false);
assert.deepStrictEqual(Object.keys(h), ['name', 'shipping', 'cardInfo', 'sameAsBilling', 'groupId', 'id', 'encrypted']);

// Polar profile with a different billing address -> Hayha uses shipping and warns
{
  const diff = JSON.parse(S('polar-profile-test.json'));
  const pr = diff.polarExport.profiles[0];
  pr.sameBillingAndShippingAddress = false;
  pr.billingAddress.line1 = '999 other ave';
  const rr = convert(JSON.stringify(diff));
  const hh = JSON.parse(rr.outputText)[0];
  assert.strictEqual(hh.sameAsBilling, true);
  assert.strictEqual(hh.shipping.address, '123 main st');
  assert.ok(!('billing' in hh));
  assert.ok(rr.warnings.some((w) => /different billing/.test(w)));
}

// Round trips preserve the data that both formats share
const hp = JSON.parse(S('hayha-profile-test.hayha'))[0];
const back = JSON.parse(convert(convert(S('hayha-profile-test.hayha')).outputText).outputText)[0];
assert.strictEqual(back.shipping.address, hp.shipping.address);
assert.strictEqual(back.cardInfo.cardNumber, hp.cardInfo.cardNumber);
assert.strictEqual(back.cardInfo.expYear, hp.cardInfo.expYear);
assert.strictEqual(back.shipping.state.shortCode, hp.shipping.state.shortCode);

const ha = JSON.parse(S('hayha-account-test.hayha'))[0];
const backA = JSON.parse(convert(convert(S('hayha-account-test.hayha')).outputText).outputText)[0];
assert.strictEqual(backA.username, ha.username);
assert.strictEqual(backA.id, ha.id);
assert.deepStrictEqual(backA.site, ha.site);

// Errors
assert.throws(() => convert('not json'), /not valid JSON/);
assert.throws(() => convert('{"hello":1}'), /Unrecognized/);
assert.throws(() => convert('[]'), /empty/);

console.log('All converter tests passed.');
