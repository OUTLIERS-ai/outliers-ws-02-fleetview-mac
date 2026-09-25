'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeGrouper } = require('../lib/groups');

test('sessions group by the member folders, else Other', () => {
  const g = makeGrouper([
    { name: 'Second Brain', path: 'C:\\Demo\\Second Brain' },
    { name: 'CRM', path: 'C:/Demo/CRM' },
    { name: 'Clients', path: 'C:\\Demo\\Second Brain\\Clients' },
    { name: 'Mac vault', path: '/Users/demo/Vault' },
  ]);
  assert.equal(g('C:\\Demo\\Second Brain'), 'Second Brain');
  assert.equal(g('c:\\demo\\second brain\\Projects'), 'Second Brain');
  assert.equal(g('C:\\Demo\\Second Brain\\Clients\\acme'), 'Clients'); // most specific wins
  assert.equal(g('C:\\Demo\\CRM'), 'CRM');
  assert.equal(g('C:\\Demo\\CRM-old'), 'Other'); // the start of a name is not a match
  assert.equal(g('/Users/demo/Vault/notes'), 'Mac vault');
  assert.equal(g('/users/demo/vault'), 'Other'); // Mac and Linux paths keep their case
  assert.equal(g(''), 'Other');
});

test('no folders configured: everything is Other', () => {
  assert.equal(makeGrouper(undefined)('C:\\anything'), 'Other');
});
