import { generateText, type LanguageModel } from 'ai';
import { extractText } from 'unpdf';
import { callOptions } from '../llm.ts';
import type { LlmSettings } from '../settings.ts';

// Reading a chat file's content (chat/attachments.ts): an image by a vision model (its text word for word, and what it
// shows), a document's text without one (a PDF's text layer, a text file as it is)

// A document's text kept, at most
const MAX_DOCUMENT_CHARS = 200_000;

export const IMAGE_PROMPT = `This image was sent in a work chat. Answer in exactly two parts:
TEXT: all the text in the image, word for word, in its language, line by line; "none" when there is none.
DESCRIPTION: what the image shows and what it is about, in one or two sentences, in the language of its text (in \
Ukrainian when it has none).`;

export interface ImageRead {
  text: string | null;
  description: string | null;
}

// The two parts of the model's answer; an answer without them is taken as the description
export const parseImageReply = (reply: string): ImageRead => {
  const text = /TEXT:\**\s*([\s\S]*?)(?=\n\s*\**DESCRIPTION:|$)/i.exec(reply)?.[1]?.replace(/\**\s*$/, '').trim();
  const description = /DESCRIPTION:\**\s*([\s\S]*)$/i.exec(reply)?.[1]?.trim();

  if (text === undefined && description === undefined) {
    return { text: null, description: reply.trim() || null };
  }

  return {
    text: text && !/^["*]*(none|немає|нема|відсутній)["*.]*$/i.test(text) ? text : null,
    description: description || null,
  };
};

export const imageMediaType = (file: { name: string, type: string | null }) => {
  if (file.type?.startsWith('image/')) {
    return file.type;
  }

  const extension = /\.(\w+)$/.exec(file.name)?.[1]?.toLowerCase();

  return extension === 'jpg' ? 'image/jpeg' : `image/${extension ?? 'png'}`;
};

export const describeImage = async (
  model: LanguageModel, settings: LlmSettings, image: Uint8Array, mediaType: string, abortSignal?: AbortSignal,
) => {
  const { text } = await generateText({
    model,
    abortSignal,
    maxOutputTokens: 2000,
    ...callOptions(settings),
    // As base64: ollama-ai-provider-v2 sends a Uint8Array as a JSON object, which Ollama refuses
    messages: [{ role: 'user', content: [{ type: 'text', text: IMAGE_PROMPT }, { type: 'image', image: Buffer.from(image).toString('base64'), mediaType }] }],
  });

  return parseImageReply(text);
};

// Empty for a scanned PDF, which has no text layer
export const readDocument = async (bytes: Uint8Array, file: { name: string, type: string | null }) => {
  const text = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    ? (await extractText(new Uint8Array(bytes), { mergePages: false })).text.join('\n\n')
    : new TextDecoder().decode(bytes);

  return text.replace(/[ \t]+\n/g, '\n').trim().slice(0, MAX_DOCUMENT_CHARS);
};
