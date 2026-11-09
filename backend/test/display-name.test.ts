import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayNameKey, isValidDisplayName, normalizeDisplayName } from '../src/auth/validation/display-name';
import { AuthValidationPipe } from '../src/auth/validation/auth-validation.pipe';
import { UpdateAccountDto } from '../src/auth/dto/update-account.dto';

const pipe = new AuthValidationPipe();
const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateAccountDto });
const accepts = (name: string) => isValidDisplayName(normalizeDisplayName(name));

describe('display name rules', () => {
  it('accepts letters of any script, digits, punctuation, symbols and emoji', () => {
    for (const name of ['Grand Master', 'Émile Zola', 'Łukasz', 'Ğürkan', 'Владимир', '王小明', 'محمد',
      'שחמט', 'Tom ♞', 'Ana 🙂', 'Ana 👍🏽', 'R2-D2', 'O\'Neil', 'abc', 'x'.repeat(20)]) {
      assert.ok(accepts(name), name);
    }
  });

  it('rejects invisible, control and look-only characters', () => {
    for (const name of [
      'ab​cd', // zero-width space
      'ab‍cd', // zero-width joiner
      'abc‮dcba', // right-to-left override
      'ab⁦cd', // bidi isolate
      'ab\u0000cd', // NUL
      'ab\tcd', 'ab\ncd', 'ab cd', // tab, line breaks
      'ab cd', // no-break space
      'abcd', // private use
      'ab￾cd', // noncharacter
      'ab\uD800cd', // lone surrogate
      '́́́', // only combining marks
      '♞♞♞', '!!!', '🙂🙂🙂', // no letter or digit
    ]) {
      assert.equal(accepts(name), false, JSON.stringify(name));
    }
  });

  it('counts code points: 3 to 20', () => {
    assert.equal(accepts('ab'), false);
    assert.equal(accepts('x'.repeat(21)), false);
    assert.equal(accepts('🙂a🙂'), true); // 3 code points, 5 UTF-16 units
    assert.equal(accepts('a'.repeat(19) + '🙂'), true);
    assert.equal(accepts('a'.repeat(20) + '🙂'), false);
  });

  it('normalizes: NFC, trim, single inner spaces', () => {
    assert.equal(normalizeDisplayName('  Grand    Master  '), 'Grand Master');
    assert.equal(normalizeDisplayName('Émile'), 'Émile'); // decomposed É becomes one code point
    assert.equal(normalizeDisplayName(42), 42);
  });

  it('the key ignores case and folds look-alike forms', () => {
    assert.equal(displayNameKey('Tom'), displayNameKey('tOM'));
    assert.equal(displayNameKey('Ｔｏｍ'), 'tom'); // fullwidth
    assert.equal(displayNameKey('ﬁsh'), 'fish'); // ligature
    assert.equal(displayNameKey('ÉMILE'), displayNameKey('émile'));
    assert.equal(displayNameKey('ADMIN'), 'admin');
    assert.notEqual(displayNameKey('Tom'), displayNameKey('Tim'));
  });
});

describe('UpdateAccountDto through the global pipe', () => {
  it('normalizes a valid name and allows "" to clear it', async () => {
    assert.equal(((await validate({ displayName: '  Grand   Master ' })) as UpdateAccountDto).displayName, 'Grand Master');
    assert.equal(((await validate({ displayName: '   ' })) as UpdateAccountDto).displayName, '');
  });

  it('rejects bad values, other types and extra keys without echoing them', async () => {
    for (const body of [{ displayName: 'ab​cd' }, { displayName: null }, { displayName: 5 },
      { displayName: ['Tom'] }, {}, { displayName: 'Tom', username: 'hacker' }, null, 'Tom']) {
      await assert.rejects(validate(body), (error: any) => {
        assert.equal(error.status, 400);
        assert.ok(!JSON.stringify(error.getResponse()).includes('hacker'));
        return true;
      });
    }
  });
});
