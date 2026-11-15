import { expect, it } from 'vitest';
import { asciiDigits, readableParagraphs, readableHindi } from '@/lib/hindi-readability';

it('writes Devanagari digits as 0-9 so numbers look the same everywhere', () => {
  expect(asciiDigits('लक्ष्य, महीने के ३,०००। उम्र १८, और 2,100 कैलोरी')).toBe('लक्ष्य, महीने के 3,000। उम्र 18, और 2,100 कैलोरी');
});

it('joins a paragraph that was cut in the middle of a sentence with the next one', () => {
  const cut = 'सबसे सुरक्षित नौकरी भी कभी-कभी\n\nसबसे कड़ी सुरक्षा वाली जेल जैसी लग सकती है, है ना?\n\nपेशा कोई भी हो।';
  expect(readableParagraphs(cut)).toBe('सबसे सुरक्षित नौकरी भी कभी-कभी सबसे कड़ी सुरक्षा वाली जेल जैसी लग सकती है, है ना?\n\nपेशा कोई भी हो।');
});

it('keeps paragraphs that already end on a full sentence separate', () => {
  expect(readableHindi('पहला हिस्सा पूरा है।\n\nदूसरा भी पूरा है!')).toBe('पहला हिस्सा पूरा है।\n\nदूसरा भी पूरा है!');
});

it('uses the agreed approximate rupee rates for money hints', async () => {
  const { RUPEE_RATES, RUPEE_HINT_RULE } = await import('@/lib/hindi-readability');
  const rate = (name: string) => RUPEE_RATES.find(r => r.currency.startsWith(name))?.rupees;
  expect(rate('US dollar')).toBe(85);
  expect(rate('British pound')).toBe(110);
  expect(rate('Hong Kong dollar')).toBe(11);
  expect(RUPEE_HINT_RULE).toContain('1 US dollar (डॉलर) ≈ 85 रुपये');
});
