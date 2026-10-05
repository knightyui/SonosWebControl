import path from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultDir=path.dirname(fileURLToPath(import.meta.url));
export const dataDir=process.env.SONOS_DATA_DIR?path.resolve(process.env.SONOS_DATA_DIR):defaultDir;
