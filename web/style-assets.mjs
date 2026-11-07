import {readFile} from 'node:fs/promises';
import path from 'node:path';

// Stylesheet ownership and load order match public/style.css.
export const STYLE_ASSETS = Object.freeze([
  'tokens',
  'base',
  'controls',
  'library',
  'player',
  'navigation',
  'sheets',
  'responsive',
  'accessibility'
].map(name => `styles/${name}.css`));

// Serve one request while keeping component sources independent.
export async function buildStyleBundle(publicDirectory) {
  const sources = await Promise.all(STYLE_ASSETS.map(file =>
    readFile(path.join(publicDirectory, file), 'utf8')
  ));
  return sources.join('\n');
}
