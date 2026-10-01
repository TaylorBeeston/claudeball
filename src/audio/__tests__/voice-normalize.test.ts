import { describe, expect, it } from 'vitest';
import { averageWords, cardinal, normalizeForSpeech as n, ordinalWord, wordsOf } from '../voice/normalize';

describe('voice normaliser', () => {
  it('spells cardinals', () => {
    expect(cardinal(0)).toBe('zero');
    expect(cardinal(13)).toBe('thirteen');
    expect(cardinal(94)).toBe('ninety-four');
    expect(cardinal(100)).toBe('one hundred');
    expect(cardinal(412)).toBe('four hundred and twelve');
    expect(cardinal(130)).toBe('one hundred and thirty');
    expect(cardinal(1500)).toBe('one thousand five hundred');
  });

  it('spells ordinals', () => {
    expect(ordinalWord(1)).toBe('first');
    expect(ordinalWord(9)).toBe('ninth');
    expect(ordinalWord(12)).toBe('twelfth');
    expect(ordinalWord(20)).toBe('twentieth');
    expect(ordinalWord(21)).toBe('twenty-first');
    expect(n('top of the 11th')).toBe('top of the eleventh');
  });

  it('reads the game sentences the way an announcer would', () => {
    expect(n('Now batting, number 23, Aaron Abbott.')).toBe('Now batting, number twenty-three, Aaron Abbott.');
    expect(n('Mike Smith grounds out, 6-3.')).toBe('Mike Smith grounds out, six-three.');
    expect(n('Mike Smith grounds into a double play, 6-4-3.')).toBe('Mike Smith grounds into a double play, six-four-three.');
    expect(n('That one left the bat at 108 miles an hour.')).toBe('That one left the bat at one hundred and eight miles an hour.');
    expect(n('swings, and it’s outta here! 412 feet!')).toBe("swings, and it's outta here! four hundred and twelve feet!");
    expect(n('Portland Comets 5, Austin Foxes 3.')).toBe('Portland Comets five, Austin Foxes three.');
    expect(n('Zach Young is 2 for 4 today.')).toBe('Zach Young is two for four today.');
    expect(n('He is 3-for-4 tonight')).toBe('He is three for four tonight');
    expect(n('Kyle Lee hits a ground-rule double.')).toBe('Kyle Lee hits a ground-rule double.');
  });

  it('reads averages, ERAs and decimals', () => {
    expect(averageWords('241')).toBe('two forty-one');
    expect(averageWords('300')).toBe('three hundred');
    expect(averageWords('305')).toBe('three-oh-five');
    expect(averageWords('075')).toBe('oh seventy-five');
    expect(n('batting .241')).toBe('batting two forty-one');
    expect(n('with a 3.45 E R A')).toBe('with a three forty-five E R A');
    expect(n('an ERA of 2.05')).toBe('an E R A of two oh five');
    expect(n('94.5 on the gun')).toBe('ninety-four point five on the gun');
    expect(n('62%')).toBe('sixty-two percent');
  });

  it('handles abbreviations and team codes', () => {
    expect(n('Sam Reed Jr. singles')).toBe('Sam Reed junior singles');
    expect(n('POR at AUS')).toBe('P O R at A U S');
    expect(n('his 12 RBI')).toBe('his twelve R B I');
    expect(n('95 mph')).toBe('ninety-five miles an hour');
  });

  it('adds the article the sim leaves out before positions', () => {
    expect(n('Riley Scott flies out to pitcher.')).toBe('Riley Scott flies out to the pitcher.');
    expect(n('Mason Watson reaches on an error by shortstop.')).toBe('Mason Watson reaches on an error by the shortstop.');
    expect(n('Diving catch by the shortstop!')).toBe('Diving catch by the shortstop!');
  });

  it('is idempotent on spoken text and tidies whitespace', () => {
    const s = 'Strike three, swinging!  And that is the ballgame .';
    expect(n(n(s))).toBe(n(s));
    expect(n(' a  b ')).toBe('a b');
  });

  it('extracts words', () => {
    expect(wordsOf("Ninety-four, and it's outta here!")).toEqual(['ninety-four', 'and', "it's", 'outta', 'here']);
  });
});
