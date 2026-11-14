import { describe, expect, it } from 'vitest';
import { attachmentKind } from '../../core/chat/attachments.ts';
import { parseImageReply, readDocument } from '../../core/chat/read.ts';
import { toChatMessage } from '../../core/rocketchat/convert.ts';
import { tinyPdf } from './pdf.ts';

describe('chat files', () => {
  it('reads the two parts of a vision model\'s answer, and takes another answer as the description', () => {
    expect(parseImageReply('TEXT: Error 500\\nat /api/orders\nDESCRIPTION: Скріншот помилки'.replace('\\n', '\n'))).toEqual({
      text: 'Error 500\nat /api/orders', description: 'Скріншот помилки',
    });
    expect(parseImageReply('**TEXT:** none\n**DESCRIPTION:** Фото дошки зі схемою')).toEqual({ text: null, description: 'Фото дошки зі схемою' });
    expect(parseImageReply('Кіт на клавіатурі')).toEqual({ text: null, description: 'Кіт на клавіатурі' });
  });

  it('reads a PDF\'s text layer and a text file', async () => {
    expect(await readDocument(tinyPdf('Budget 2026 approved'), { name: 'report.pdf', type: 'application/pdf' })).toContain('Budget 2026 approved');
    expect(await readDocument(new TextEncoder().encode('Бюджет\n'), { name: 'notes.txt', type: null })).toBe('Бюджет');
  });

  it('reads images and documents only, and leaves out an image\'s thumbnail', () => {
    expect(['a.png', 'b.JPG', 'c.pdf', 'd.svg', 'e.zip'].map((name) => attachmentKind({ name }))).toEqual(['image', 'image', 'document', null, null]);
    expect(attachmentKind({ name: 'x', type: 'image/svg+xml' })).toBeNull();

    const message = toChatMessage({
      _id: 'm', rid: 'r', msg: '', ts: '2026-11-10T11:00:00Z', _updatedAt: '2026-11-10T11:00:00Z', u: { _id: 'u', username: 'olena' },
      files: [{ _id: 'f1', name: 'screen shot.png', type: 'image/png', size: 10 }, { _id: 'f2', name: 'thumb-screen shot.png', typeGroup: 'thumb' }],
      attachments: [{ type: 'file', title: 'screen shot.png' }],
    });

    expect(message?.files).toEqual(['screen shot.png']);
    expect(message?.attachments).toEqual([{ id: 'f1', name: 'screen shot.png', type: 'image/png', size: 10, path: '/file-upload/f1/screen%20shot.png' }]);
  });
});
