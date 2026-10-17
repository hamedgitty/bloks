// Test-only interception at the real relay publication boundary, never an app import.
import { appendFileSync } from 'node:fs';
import { RelayLink } from '../../server/relay-link.ts';
const trace = process.env.BLOKS_PROGRESS_TRACE;
if (!trace || !process.env.HOME?.includes('bloks-progress-')) throw new Error('disposable progress fixture required');
let count = 0;
RelayLink.prototype.publish = function (frame, wake) {
  if (++count > 5000) throw new Error('bounded fixture trace exhausted');
  appendFileSync(trace, JSON.stringify({ frame, wake: wake ?? null, preview: this.previewOf(frame) }) + '\n');
};
