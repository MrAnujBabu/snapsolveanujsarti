import { describe, expect, it } from 'vitest';
import { checkpointKey, parseCheckpointKey } from './interpret-checkpoint';

describe('parseCheckpointKey', () => {
  it('recovers the link and settings of saved work', () => {
    const key = checkpointKey({ kind: 'link', url: 'https://youtu.be/abc?t=1' }, 'claude' as never, true, false, true);
    expect(parseCheckpointKey(key)).toMatchObject({ kind: 'link', url: 'https://youtu.be/abc?t=1', engine: 'claude', quality: true, deepListen: false, verbatim: true });
  });
  it('reads the file name of an upload', () => {
    const key = checkpointKey({ kind: 'file', file: { name: 'class.mp4', size: 10, lastModified: 5 } }, 'gpt' as never, false, true);
    expect(parseCheckpointKey(key)).toMatchObject({ kind: 'file', fileName: 'class.mp4', quality: false, deepListen: true, verbatim: false });
  });
});
