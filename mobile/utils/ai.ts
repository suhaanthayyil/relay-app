import type { CameraView } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { chatCompletion } from './relayApi';

// Downscale before upload: faster, cheaper, and well under the proxy's body limit.
export async function captureForAI(camera: CameraView | null, maxWidth: number): Promise<string> {
  if (!camera) throw new Error('Camera is not ready');
  const photo = await camera.takePictureAsync({ quality: 0.7, skipProcessing: false });
  if (!photo?.uri) throw new Error('No camera frame captured');
  const resized = await manipulateAsync(
    photo.uri,
    photo.width > maxWidth ? [{ resize: { width: maxWidth } }] : [],
    { compress: 0.6, format: SaveFormat.JPEG, base64: true }
  );
  if (!resized.base64) throw new Error('Could not encode the photo');
  return resized.base64;
}

export async function describeSurroundings(
  base64Jpeg: string,
  question: string,
  languageName: string,
  detail: 'low' | 'high' = 'low'
): Promise<string> {
  const query = question.trim() || 'What is in front of me?';
  return chatCompletion({
    model: 'gpt-6-luna',
    maxTokens: 150,
    temperature: 0.2,
    system:
      'You are a navigation assistant for a blind or low-vision person. Answer their question about what the camera sees. ' +
      'Give physical, spatial directions (for example: to your left, at 2 o\'clock, about three steps ahead). ' +
      'Mention hazards first. Keep it to 1-3 short sentences. Do not mention the image or the camera. ' +
      `Reply only in ${languageName}.`,
    user: [
      { type: 'text', text: `Question: ${query}` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Jpeg}`, detail } },
    ],
  });
}

export async function readTextInImage(base64Jpeg: string, languageName: string): Promise<string> {
  return chatCompletion({
    model: 'gpt-6-luna',
    maxTokens: 700,
    temperature: 0,
    timeoutMs: 40000,
    system:
      'You read printed text aloud for a blind or low-vision person. Read the text in the photo in natural reading order. ' +
      'For signs, labels, and menus, read the most important text first. Skip decorative or repeated text. ' +
      'If there is no readable text, briefly describe what the camera sees instead. ' +
      `Write the result in ${languageName}; translate the text if it is in another language.`,
    user: [
      { type: 'text', text: 'Read this aloud.' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Jpeg}`, detail: 'high' } },
    ],
  });
}

export async function catchUpSummary(lines: string[], languageName: string, keywords: string[]): Promise<string> {
  const names = keywords.length ? keywords.join(', ') : 'the user';
  return chatCompletion({
    model: 'gpt-6-luna',
    maxTokens: 350,
    temperature: 0.2,
    timeoutMs: 20000,
    system:
      'You help a Deaf or hard of hearing person catch up on a conversation from its live captions. ' +
      'Write at most 3 short bullet points starting with "- " covering what was said. ' +
      `Then, if anyone asked a question of or mentioned ${names}, add a line starting with "For you:" saying what. ` +
      'Captions can contain recognition errors; do not invent details. ' +
      `Reply only in ${languageName}.`,
    user: lines.join('\n'),
  });
}

export async function translateCaption(text: string, targetLanguage: string): Promise<string> {
  return chatCompletion({
    model: 'gpt-6-luna',
    maxTokens: 300,
    temperature: 0,
    timeoutMs: 15000,
    system: `Translate the user's text into ${targetLanguage}. Output only the translation, nothing else.`,
    user: text,
  });
}

// Feel the Conversation: shrink a caption so it can be felt as Braille in a few seconds.
export async function compressForTouch(text: string): Promise<string> {
  return chatCompletion({
    model: 'gpt-6-luna',
    maxTokens: 40,
    temperature: 0,
    timeoutMs: 8000,
    system:
      'Compress what was said into at most 5 English words that keep the meaning, like a telegram. ' +
      'Keep names, numbers (as words), questions, and warnings. Lowercase letters and spaces only, no punctuation. ' +
      'Translate to English if needed. Output only the words.',
    user: text,
  });
}

export type ObjectSighting = {
  found: boolean;
  direction: 'left' | 'center' | 'right' | null;
  distance: 'near' | 'medium' | 'far' | null;
  hint: string;
};

// Vision models place objects poorly but recognize them well, so the frame is
// sent as left, center, and right strips and the model picks the strip.
export async function captureStripsForAI(camera: CameraView | null, width = 768): Promise<string[]> {
  if (!camera) throw new Error('Camera is not ready');
  const photo = await camera.takePictureAsync({ quality: 0.6, skipProcessing: false });
  if (!photo?.uri) throw new Error('No camera frame captured');
  const frame = await manipulateAsync(photo.uri, [{ resize: { width } }], { compress: 0.8, format: SaveFormat.JPEG });
  const stripWidth = Math.floor(frame.width / 3);
  const strips = await Promise.all(
    [0, 1, 2].map((index) =>
      manipulateAsync(
        frame.uri,
        [{ crop: { originX: index * stripWidth, originY: 0, width: stripWidth, height: frame.height } }],
        { compress: 0.6, format: SaveFormat.JPEG, base64: true }
      )
    )
  );
  if (strips.some((strip) => !strip.base64)) throw new Error('Could not encode the photo');
  return strips.map((strip) => strip.base64 as string);
}

const STRIP_NAMES = ['LEFT', 'CENTER', 'RIGHT'] as const;

// Find My Object: one low-detail request per check keeps each check fast.
export async function locateObject(strips: string[], target: string, languageName: string): Promise<ObjectSighting> {
  const raw = await chatCompletion({
    model: 'gpt-6-luna',
    maxTokens: 80,
    temperature: 0,
    timeoutMs: 12000,
    system:
      'You help a blind person find an object with their phone camera. The camera frame is split into three images: LEFT, CENTER and RIGHT strips, in that order. ' +
      'Reply with JSON only: {"found": boolean, "strip": "left"|"center"|"right"|null, "distance": "near"|"medium"|"far"|null, "hint": string}. ' +
      'strip is the strip where most of the object is. distance is near if the object looks large and close. ' +
      `hint is at most 6 words of guidance in ${languageName}, for example "on the table". Only say found if you are confident.`,
    user: [
      { type: 'text', text: `Find: ${target}` },
      ...strips.flatMap((strip, index) => [
        { type: 'text' as const, text: STRIP_NAMES[index] },
        { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${strip}`, detail: 'low' as const } },
      ]),
    ],
  });
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const data = JSON.parse(match ? match[0] : raw);
    const direction = ['left', 'center', 'right'].includes(data.strip) ? data.strip : null;
    const distance = ['near', 'medium', 'far'].includes(data.distance) ? data.distance : null;
    const found = Boolean(data.found);
    return { found, direction: found ? direction : null, distance: found ? distance : null, hint: found ? String(data.hint || '').slice(0, 80) : '' };
  } catch {
    return { found: false, direction: null, distance: null, hint: '' };
  }
}
