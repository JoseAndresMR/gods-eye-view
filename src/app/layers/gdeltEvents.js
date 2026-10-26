import { createGdeltEventsLayer } from '../../layers/gdeltEvents/index.js';
/** Wire the GDELT conflict-event layer to the application. */
export function createApplicationGdeltEvents(options) {
  return createGdeltEventsLayer(options);
}
