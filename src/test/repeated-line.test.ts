import { describe, expect, it } from 'vitest';
import { danglingTail, dubSpeechText, isRepeatedLine, speakableText } from '@/lib/repeated-line';
import { SPEAK_ONCE_RULE, closeSpokenText } from '@/lib/youtube-voice-profile';
import { indianTeacherPrompt } from '@/routes/api/speech';

describe('repeated voice lines', () => {
  it('treats the same line again as a repeat', () => {
    expect(isRepeatedLine('पहला सवाल: ठंड कैसे लें?', 'पहला सवाल:  ठंड कैसे लें')).toBe(true);
  });
  it('does not skip a different line', () => {
    expect(isRepeatedLine('दूसरा सवाल', 'पहला सवाल')).toBe(false);
  });
  it('does not skip the first line', () => {
    expect(isRepeatedLine('पहला सवाल', undefined)).toBe(false);
  });
  it('speaks a doubled last sentence only once', () => {
    expect(speakableText('संदेश जाता है। संदेश तेज़ी से पहुँचता है। संदेश तेज़ी से पहुँचता है।'))
      .toBe('संदेश जाता है। संदेश तेज़ी से पहुँचता है।');
  });
  it('drops a first sentence that repeats the previous part\'s last sentence', () => {
    expect(speakableText('संदेश तेज़ी से पहुँचता है। फिर चर्बी जलती है।', 'पानी ठंडा है। संदेश तेज़ी से पहुँचता है।'))
      .toBe('फिर चर्बी जलती है।');
  });
  it('tells the backup voice to read the text once', () => {
    expect(indianTeacherPrompt('नमस्ते।', true)).toContain(SPEAK_ONCE_RULE);
    expect(indianTeacherPrompt('नमस्ते।')).toContain(SPEAK_ONCE_RULE);
  });
  it('closes a part that stops mid-sentence so the last word is not repeated', () => {
    expect(closeSpokenText('मनचाहा चुनें, क्योंकि')).toBe('मनचाहा चुनें, क्योंकि।');
    expect(closeSpokenText('मैंने पूरा online,')).toBe('मैंने पूरा online।');
  });
  it('leaves a part that already ends a sentence unchanged', () => {
    expect(closeSpokenText('ज़रूर अपनाएँ!')).toBe('ज़रूर अपनाएँ!');
    expect(closeSpokenText('बदलाव नहीं हुआ।')).toBe('बदलाव नहीं हुआ।');
  });
});

describe('dub parts cut mid-sentence', () => {
  const parts = ['सैकड़ों cards; पूरे करना बोझ। अगर', 'मेरी तरह रोज़ बैठकर पढ़ने का discipline नहीं है, तो ये परेशानी बन सकते हैं।'];
  it('moves the unfinished last word to the next part instead of speaking it alone', () => {
    expect(dubSpeechText(parts[0]!, undefined, true)).toBe('सैकड़ों cards; पूरे करना बोझ।');
    expect(dubSpeechText(parts[1]!, parts[0], true)).toBe('अगर मेरी तरह रोज़ बैठकर पढ़ने का discipline नहीं है, तो ये परेशानी बन सकते हैं।');
  });
  it('keeps the tail of the very last part, and never splits a decimal number', () => {
    expect(dubSpeechText('मैं घर गया। अलविदा', 'पहले।', false)).toBe('मैं घर गया। अलविदा');
    expect(danglingTail('dose है 2.5')).toBe('');
    expect(danglingTail('यह बात है। फिर हमने दस अलग अलग बातें कहीं जो लंबी थीं')).toBe('');
  });
});
